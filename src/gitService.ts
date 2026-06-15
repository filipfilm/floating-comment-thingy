/**
 * Git service — wraps the VS Code Git extension API.
 * Provides access to repository state, branches, commits, and diffs.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import type { GitExtension, API as GitAPI, Repository } from './types/git';

export class GitService {
  private gitApi: GitAPI | undefined;
  private disposables: vscode.Disposable[] = [];

  /** Listeners for repository state changes (branch switch, commit, etc.) */
  private stateChangeListeners: ((repo: Repository) => void)[] = [];

  async initialize(): Promise<boolean> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      console.warn('[FCT] Git extension not found');
      return false;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    this.gitApi = gitExtension.exports.getAPI(1);

    // Watch for state changes on existing and new repositories
    for (const repo of this.gitApi.repositories) {
      this.watchRepository(repo);
    }

    this.disposables.push(
      this.gitApi.onDidOpenRepository((repo) => {
        this.watchRepository(repo);
      })
    );

    return true;
  }

  private watchRepository(repo: Repository): void {
    const disposable = repo.state.onDidChange(() => {
      for (const listener of this.stateChangeListeners) {
        listener(repo);
      }
    });
    this.disposables.push(disposable);
  }

  /**
   * Register a callback for Git state changes (branch switch, new commit, etc.)
   */
  onDidChangeState(listener: (repo: Repository) => void): vscode.Disposable {
    this.stateChangeListeners.push(listener);
    return {
      dispose: () => {
        const idx = this.stateChangeListeners.indexOf(listener);
        if (idx >= 0) {
          this.stateChangeListeners.splice(idx, 1);
        }
      },
    };
  }

  /**
   * Find the Git repository for a given file URI.
   */
  getRepository(uri: vscode.Uri): Repository | undefined {
    if (!this.gitApi) { return undefined; }
    // Try the specific API method first
    const repo = this.gitApi.getRepository(uri);
    if (repo) { return repo; }

    // Fallback: find a repo whose root contains the file
    for (const r of this.gitApi.repositories) {
      if (uri.fsPath.startsWith(r.rootUri.fsPath)) {
        return r;
      }
    }
    return undefined;
  }

  /**
   * Get the current branch name for a file's repository.
   */
  getCurrentBranch(uri: vscode.Uri): string | undefined {
    const repo = this.getRepository(uri);
    return repo?.state.HEAD?.name;
  }

  /**
   * Get the current commit hash for a file's repository.
   */
  getCurrentCommitHash(uri: vscode.Uri): string | undefined {
    const repo = this.getRepository(uri);
    return repo?.state.HEAD?.commit;
  }

  /**
   * Get a unique identifier for the repository (remote URL or root path).
   */
  getRepoId(uri: vscode.Uri): string {
    const repo = this.getRepository(uri);
    if (!repo) {
      return 'local';
    }

    // Prefer remote origin URL as repo ID
    const origin = repo.state.remotes.find(r => r.name === 'origin');
    if (origin?.fetchUrl) {
      return origin.fetchUrl;
    }

    // Fallback to root path
    return repo.rootUri.fsPath;
  }

  /**
   * Get the workspace-relative file path.
   */
  getRelativePath(uri: vscode.Uri): string {
    const repo = this.getRepository(uri);
    if (repo) {
      const rootPath = repo.rootUri.fsPath;
      let relative = uri.fsPath.substring(rootPath.length);
      // Normalize path separators and remove leading slash
      relative = relative.replace(/\\/g, '/');
      if (relative.startsWith('/')) {
        relative = relative.substring(1);
      }
      return relative;
    }

    // Fallback to workspace-relative path
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      return vscode.workspace.asRelativePath(uri, false);
    }

    return uri.fsPath;
  }

  /**
   * Get the diff between two commits for a specific file.
   * Uses `git diff` under the hood via the repository's exec method.
   */
  async getDiff(uri: vscode.Uri, fromCommit: string, toCommit: string): Promise<string> {
    const repo = this.getRepository(uri);
    if (!repo) {
      return '';
    }

    const relativePath = this.getRelativePath(uri);

    try {
      // Use the repository's diff method if available
      const result = await repo.diffBetween(fromCommit, toCommit, relativePath);
      return result;
    } catch (error) {
      console.warn('[FCT] Failed to get diff:', error);
      return '';
    }
  }

  /**
   * Get the full text content of a file at a specific commit.
   */
  async getFileAtCommit(uri: vscode.Uri, commitHash: string): Promise<string | undefined> {
    const repo = this.getRepository(uri);
    if (!repo) { return undefined; }

    const relativePath = this.getRelativePath(uri);

    try {
      const result = await repo.show(commitHash, relativePath);
      return result;
    } catch {
      return undefined;
    }
  }

  /**
   * Get unique contributors across the repository for autocomplete.
   * Uses execFile (no shell) to prevent command injection.
   */
  async getContributors(uri: vscode.Uri): Promise<string[]> {
    const repo = this.getRepository(uri);
    if (!repo) return [];

    return new Promise((resolve) => {
      cp.execFile('git', ['log', '--format=%aN'], { cwd: repo.rootUri.fsPath }, (err, stdout) => {
        if (err) {
          console.warn('[FCT] getContributors error:', err);
          resolve([]);
          return;
        }
        // De-dupe in JS instead of relying on a shell pipe
        const names = [...new Set(
          stdout.split('\n').map(n => n.trim()).filter(Boolean)
        )].sort();
        resolve(names);
      });
    });
  }

  /**
   * Get the author name from git blame for a specific line.
   * Uses execFileSync (no shell) to prevent command injection via crafted file paths.
   */
  getBlameAuthor(uri: vscode.Uri, line: number): string | undefined {
    const repo = this.getRepository(uri);
    if (!repo) return undefined;

    const relativePath = this.getRelativePath(uri);
    try {
      const output = cp.execFileSync(
        'git',
        ['blame', `-L${line},${line}`, '--porcelain', relativePath],
        { cwd: repo.rootUri.fsPath, encoding: 'utf8', timeout: 2000 }
      );
      const match = output.match(/^author\s+(.+)$/m);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch (err) {
      console.warn('[FCT] getBlameAuthor error:', err);
    }
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.stateChangeListeners = [];
  }
}
