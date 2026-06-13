/**
 * URI handler for FCT deep links.
 *
 * Handles URIs of the form:
 *   vscode://filipdobosz.fct/open?file=path/to/file.ts&line=42
 *
 * When a user clicks a notification link (e.g., from Slack/Discord),
 * this opens the file in VS Code and scrolls to the specified line.
 */

import * as vscode from 'vscode';

export class FCTUriHandler implements vscode.UriHandler {

  async handleUri(uri: vscode.Uri): Promise<void> {
    const params = new URLSearchParams(uri.query);
    const filePath = params.get('file');
    const lineStr = params.get('line');
    const threadId = params.get('threadId');

    if (!filePath) {
      vscode.window.showWarningMessage('[FCT] Deep link missing file parameter');
      return;
    }

    try {
      // Try to find the file in the workspace
      const fileUri = await this.resolveFileUri(filePath);
      if (!fileUri) {
        vscode.window.showWarningMessage(`[FCT] Could not find file: ${filePath}`);
        return;
      }

      // Open the file
      const document = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(document);

      // Scroll to the specified line
      if (lineStr) {
        const line = parseInt(lineStr, 10) - 1; // Convert to 0-indexed
        if (!isNaN(line) && line >= 0 && line < document.lineCount) {
          const position = new vscode.Position(line, 0);
          const range = new vscode.Range(position, position);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
      }

      // If a threadId was provided, we could expand the specific comment thread
      // The vscode.comments API doesn't expose a way to programmatically expand
      // a specific thread, but the user will see it since we scrolled to the line
      if (threadId) {
        console.log(`[FCT] Deep link targeted thread: ${threadId}`);
      }

    } catch (error) {
      vscode.window.showErrorMessage(`[FCT] Failed to open deep link: ${error}`);
    }
  }

  /**
   * Resolve a relative file path to a workspace URI.
   */
  private async resolveFileUri(filePath: string): Promise<vscode.Uri | undefined> {
    // Try workspace-relative lookup
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const candidate = vscode.Uri.joinPath(folder.uri, filePath);
        try {
          await vscode.workspace.fs.stat(candidate);
          return candidate;
        } catch {
          // File not found in this folder, try next
        }
      }
    }

    // Try as absolute path
    try {
      const absoluteUri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.stat(absoluteUri);
      return absoluteUri;
    } catch {
      return undefined;
    }
  }
}
