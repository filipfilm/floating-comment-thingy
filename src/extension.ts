/**
 * FCT — Floating Comment Thingy
 *
 * Extension entry point.
 * Wires together the comment controller, Git service, storage, WebSocket client,
 * and URI handler.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FCTCommentController, NoteComment } from './commentController';
import { GitService } from './gitService';
import { createStorage } from './storage';
import { FCTWebSocketClient } from './websocketClient';
import { FCTUriHandler } from './uriHandler';
import { FCTTreeDataProvider } from './treeView';
import { FCTCodeLensProvider } from './codeLensProvider';
import { exportActiveComments } from './export';
import { FCTMentionProvider } from './mentionProvider';
import { FCTThread } from './types';

let commentController: FCTCommentController;
let gitService: GitService;
let wsClient: FCTWebSocketClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[FCT] Floating Comment Thingy is activating...');

  // ─── Initialize Git service ──────────────────────────────────────
  gitService = new GitService();

  // ─── Initialize storage ──────────────────────────────────────────
  const storage = await createStorage(context);

  // ─── Initialize comment controller ───────────────────────────────
  commentController = new FCTCommentController(storage, gitService);

  // ─── Register commands ───────────────────────────────────────────

  // "Add Comment" — triggered when user submits text in the comment reply box
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.addComment', (reply: vscode.CommentReply) => {
      commentController.addComment(reply);
    })
  );

  // "Reply to Comment" — same handler, VS Code routes replies through the same mechanism
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.replyToComment', (reply: vscode.CommentReply) => {
      commentController.addComment(reply);
    })
  );

  // "Edit Comment"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.editComment', (comment: NoteComment) => {
      commentController.editComment(comment);
    })
  );

  // "Save Edit"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.saveEdit', (comment: NoteComment) => {
      commentController.saveEdit(comment);
    })
  );

  // "Cancel Edit"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.cancelEdit', (comment: NoteComment) => {
      commentController.cancelEdit(comment);
    })
  );

  // "Delete Comment"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.deleteComment', (comment: NoteComment) => {
      commentController.deleteComment(comment);
    })
  );

  // "Resolve Thread"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.resolveThread', (thread: vscode.CommentThread) => {
      commentController.resolveThread(thread);
    })
  );

  // "Unresolve Thread"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.unresolveThread', (thread: vscode.CommentThread) => {
      commentController.unresolveThread(thread);
    })
  );

  // "Delete Thread"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.deleteThread', (thread: vscode.CommentThread) => {
      commentController.deleteThread(thread);
    })
  );

  // "Create Comment From Selection"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.createCommentFromSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        commentController.createEmptyThread(editor);
      }
    })
  );

  // "Copy Code Quote"
  context.subscriptions.push(
    vscode.commands.registerCommand('fct.copyCodeQuote', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (!text) {
          vscode.window.showInformationMessage('[FCT] No code selected to quote.');
          return;
        }
        
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const lineStart = selection.start.line + 1;
        
        // Build the quote blocks
        const quote = text.split('\n').map(line => `> ${line}`).join('\n');
        
        // Use context.extension.id to avoid publisher hardcoding
        const extensionId = context.extension.id; // e.g. "filipdobosz.fct"
        const deepLink = `vscode://${extensionId}/open?file=${encodeURIComponent(fileName)}&line=${lineStart}`;
        
        // Provide the markdown representation
        const ext = fileName.split('.').pop() || '';
        const markdown = `> \`\`\`${ext}\n${quote}\n> \`\`\`\n> [${fileName}:${lineStart}](${deepLink})`;
        
        await vscode.env.clipboard.writeText(markdown);
        vscode.window.showInformationMessage('Code quote copied to clipboard!');
      }
    })
  );

  // ─── Register URI handler ───────────────────────────────────────
  const uriHandler = new FCTUriHandler();
  context.subscriptions.push(
    vscode.window.registerUriHandler(uriHandler)
  );

  // ─── Register TreeView ──────────────────────────────────────────
  const treeDataProvider = new FCTTreeDataProvider(storage);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('fct.commentsView', treeDataProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fct.revealComment', async (thread: FCTThread) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) return;
      const repoId = workspaceFolders[0].uri.fsPath;
      
      const uri = vscode.Uri.file(path.join(repoId, thread.filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      
      const pos = new vscode.Position(thread.currentStartLine - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fct.exportActiveComments', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace open to export comments from.');
        return;
      }
      const repoId = workspaceFolders[0].uri.fsPath;
      await exportActiveComments(storage, repoId);
    })
  );

  // ─── Register Hover Provider ─────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover: (document, position) => {
        return commentController.provideHover(document, position);
      }
    })
  );

  // ─── Register CodeLens Provider ──────────────────────────────────
  const codeLensProvider = new FCTCodeLensProvider(storage, gitService);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );

  // ─── Register Mention Provider ───────────────────────────────────
  const mentionProvider = new FCTMentionProvider(gitService);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'comment' },
      mentionProvider,
      '@'
    )
  );

  // ─── Load comments for already-open documents ───────────────────
  // When the extension activates, there may already be open editors
  for (const editor of vscode.window.visibleTextEditors) {
    await commentController.loadCommentsForDocument(editor.document);
  }

  // ─── Watch for document opens ────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      // Small delay to ensure the document is fully loaded
      await new Promise(resolve => setTimeout(resolve, 100));
      await commentController.loadCommentsForDocument(document);
    })
  );

  // ─── Watch for active editor changes ─────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor) {
        await commentController.loadCommentsForDocument(editor.document);
      }
    })
  );

  // ─── Async Git Initialization ────────────────────────────────────
  // We do this asynchronously so we don't block the extension from activating
  // if the built-in Git extension is slow to load or hangs.
  gitService.initialize().then(async (gitAvailable) => {
    if (!gitAvailable) {
      vscode.window.showWarningMessage(
        '[FCT] Git extension not available. Comments will work but without Git-aware anchoring.'
      );
    } else {
      // Re-anchor existing comments now that Git is ready
      for (const editor of vscode.window.visibleTextEditors) {
        await commentController.loadCommentsForDocument(editor.document);
      }

      context.subscriptions.push(
        gitService.onDidChangeState(async () => {
          // Re-anchor comments for all visible documents on branch switch/commit
          for (const editor of vscode.window.visibleTextEditors) {
            await commentController.loadCommentsForDocument(editor.document);
          }
        })
      );
    }
  });

  // ─── Initialize WebSocket for real-time sync ────────────────────
  const config = vscode.workspace.getConfiguration('fct');
  const backendUrl = config.get<string>('backendUrl', '');

  if (backendUrl) {
    initializeWebSocket(context, backendUrl);
  }

  // ─── Watch for config changes ────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fct.backendUrl')) {
        const newUrl = vscode.workspace.getConfiguration('fct').get<string>('backendUrl', '');
        if (wsClient) {
          wsClient.dispose();
          wsClient = undefined;
        }
        if (newUrl) {
          initializeWebSocket(context, newUrl);
        }
      }
    })
  );

  // ─── Cleanup ────────────────────────────────────────────────────
  context.subscriptions.push(commentController);
  context.subscriptions.push(gitService);

  console.log('[FCT] Floating Comment Thingy is now active!');
}

/**
 * Set up the WebSocket client for real-time syncing.
 */
function initializeWebSocket(context: vscode.ExtensionContext, backendUrl: string): void {
  // Determine the repo ID for the first workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return; }

  const repoId = gitService.getRepoId(workspaceFolders[0].uri);

  wsClient = new FCTWebSocketClient(backendUrl, repoId);

  // Forward WebSocket messages to the comment controller
  const msgDisposable = wsClient.onMessage((message) => {
    commentController.handleWSMessage(message);
  });

  wsClient.connect();

  context.subscriptions.push({
    dispose: () => {
      msgDisposable.dispose();
      wsClient?.dispose();
      wsClient = undefined;
    },
  });
}

export function deactivate() {
  console.log('[FCT] Floating Comment Thingy is deactivating...');

  if (wsClient) {
    wsClient.dispose();
    wsClient = undefined;
  }
}
