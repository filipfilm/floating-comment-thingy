import * as vscode from 'vscode';
import * as path from 'path';
import { ICommentStorage } from './storage';
import { FCTThread } from './types';

export class FCTTreeDataProvider implements vscode.TreeDataProvider<FCTTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FCTTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private storage: ICommentStorage) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FCTTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FCTTreeNode): Promise<FCTTreeNode[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return [];
    
    // For now we assume a single repo/workspace folder
    const repoId = workspaceFolders[0].uri.fsPath; // Very basic repo ID inference

    if (!element) {
      // Root level: Group by file
      const threads = await this.storage.loadAllThreads(repoId);
      
      const fileMap = new Map<string, FCTThread[]>();
      for (const t of threads) {
        if (!fileMap.has(t.filePath)) {
          fileMap.set(t.filePath, []);
        }
        fileMap.get(t.filePath)!.push(t);
      }

      const nodes: FCTTreeNode[] = [];
      for (const [filePath, fileThreads] of fileMap.entries()) {
        const fileNode = new FCTTreeNode(
          path.basename(filePath),
          vscode.TreeItemCollapsibleState.Collapsed
        );
        fileNode.description = `${fileThreads.length} comments`;
        fileNode.iconPath = vscode.ThemeIcon.File;
        // Stash the raw filePath for children lookup
        fileNode.contextValue = 'fctFileNode';
        fileNode.resourceUri = vscode.Uri.file(path.join(repoId, filePath));
        
        nodes.push(fileNode);
      }

      return nodes.sort((a, b) => a.label.localeCompare(b.label));
    } else {
      // Child level: Show threads for the given file
      const threads = await this.storage.loadAllThreads(repoId);
      const filePath = path.relative(repoId, element.resourceUri!.fsPath);
      
      const fileThreads = threads.filter(t => t.filePath === filePath);
      const nodes: FCTTreeNode[] = [];

      for (const t of fileThreads) {
        let title = t.comments[0]?.body || 'Empty Thread';
        
        // Truncate
        if (title.length > 40) title = title.substring(0, 40) + '...';

        let icon = '$(comment-discussion)';
        if (t.status === 'resolved') icon = '$(check)';
        else if (t.status === 'orphaned') icon = '$(warning)';
        else if (title.match(/#p1/i)) icon = '$(error)';
        else if (title.match(/#todo/i)) icon = '$(checklist)';

        const threadNode = new FCTTreeNode(
          title,
          vscode.TreeItemCollapsibleState.None,
          t
        );
        threadNode.description = t.comments[0]?.author || 'Unknown';
        threadNode.contextValue = 'fctThreadNode';
        
        // Command to click and open
        threadNode.command = {
          command: 'fct.revealComment',
          title: 'Reveal Comment',
          arguments: [t]
        };

        nodes.push(threadNode);
      }

      return nodes;
    }
  }
}

export class FCTTreeNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly thread?: FCTThread
  ) {
    super(label, collapsibleState);
  }
}
