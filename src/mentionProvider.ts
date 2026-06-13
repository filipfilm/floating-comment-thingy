import * as vscode from 'vscode';
import { GitService } from './gitService';

export class FCTMentionProvider implements vscode.CompletionItemProvider {
  // Simple cache: repoPath -> contributors
  private contributorCache = new Map<string, string[]>();

  constructor(private gitService: GitService) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    // 1. Get the current workspace folder (since comment scheme URIs are tricky to trace to specific files natively)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return [];
    
    // We assume the primary workspace folder
    const rootUri = workspaceFolders[0].uri;
    const repoId = rootUri.fsPath;

    let contributors = this.contributorCache.get(repoId);

    // If not cached, fetch from GitService asynchronously
    if (!contributors) {
      contributors = await this.gitService.getContributors(rootUri);
      if (contributors.length > 0) {
        this.contributorCache.set(repoId, contributors);
      }
    }

    if (!contributors || contributors.length === 0) return [];

    // Check if the character right before cursor is '@'
    // Actually, triggerCharacters takes care of this, but we can verify
    const linePrefix = document.lineAt(position).text.substr(0, position.character);
    if (!linePrefix.endsWith('@')) {
      // It might be `@some` being typed. VS Code automatically filters based on trigger character and prefix.
    }

    // 2. Return the list of completion items
    const items = contributors.map(name => {
      // remove spaces for mentions, e.g. "John Doe" -> "@JohnDoe"
      const mentionName = name.replace(/\s+/g, '');
      const item = new vscode.CompletionItem(mentionName, vscode.CompletionItemKind.User);
      item.detail = name; // Full name
      item.documentation = new vscode.MarkdownString(`Tag **${name}** in this FCT comment.`);
      return item;
    });

    // Also add the special @author keyword!
    const authorItem = new vscode.CompletionItem('author', vscode.CompletionItemKind.Keyword);
    authorItem.detail = 'Dynamic Blame Tag';
    authorItem.documentation = new vscode.MarkdownString(
      `Typing \`@author\` will automatically resolve to the name of the person who last modified the anchored code line via \`git blame\`.`
    );
    items.push(authorItem);

    return items;
  }
}
