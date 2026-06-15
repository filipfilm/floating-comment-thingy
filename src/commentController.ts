/**
 * FCT Comment Controller — manages VS Code comment threads and comments.
 *
 * Bridges between the vscode.comments API (UI layer) and the storage backend.
 * Handles creating, replying, editing, deleting, and resolving comments.
 */

import * as vscode from 'vscode';
import { FCTThread, FCTComment, CreateThreadPayload, CreateReplyPayload } from './types';
import { ICommentStorage } from './storage';
import { GitService } from './gitService';
import { AnchoringEngine } from './anchoringEngine';

// ─── NoteComment class ──────────────────────────────────────────────

/**
 * Concrete implementation of vscode.Comment for FCT.
 */
export class NoteComment implements vscode.Comment {
  /** Unique FCT comment ID (maps to backend) */
  fctId: string;
  /** The FCT thread ID this comment belongs to */
  fctThreadId: string;
  /** Saved body for cancel/undo */
  savedBody: string | vscode.MarkdownString;
  /** Comment display label */
  label: string | undefined;
  /** Reactions */
  reactions?: vscode.CommentReaction[];

  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public contextValue: string,
    fctId: string,
    fctThreadId: string,
    public timestamp?: Date,
  ) {
    this.fctId = fctId;
    this.fctThreadId = fctThreadId;
    this.savedBody = body;
  }
}

// ─── Controller ─────────────────────────────────────────────────────

export class FCTCommentController {
  private controller: vscode.CommentController;
  private storage: ICommentStorage;
  private gitService: GitService;
  private anchoringEngine: AnchoringEngine;
  private disposables: vscode.Disposable[] = [];

  /**
   * Map from VS Code CommentThread to FCT thread ID.
   * We need this because there's no built-in way to associate custom data
   * with a vscode.CommentThread.
   */
  private vsThreadToFctId: Map<vscode.CommentThread, string> = new Map();

  /**
   * Map from FCT thread ID to VS Code CommentThread.
   * Used for updating threads when we receive WebSocket events.
   */
  private fctIdToVsThread: Map<string, vscode.CommentThread> = new Map();

  constructor(
    storage: ICommentStorage,
    gitService: GitService,
  ) {
    this.storage = storage;
    this.gitService = gitService;
    this.anchoringEngine = new AnchoringEngine(gitService);

    // Create the VS Code comment controller
    this.controller = vscode.comments.createCommentController('fct', 'FCT Comments');
    this.disposables.push(this.controller);

    // Allow commenting on all lines of all text documents
    this.controller.commentingRangeProvider = {
      provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
        if (document.uri.scheme !== 'file') {
          return [];
        }
        const lineCount = document.lineCount;
        return [new vscode.Range(0, 0, lineCount - 1, 0)];
      },
    };

    // Provide default available reactions
    this.controller.options = {
      prompt: 'Leave a comment...',
      placeHolder: 'Type your comment here. Use @username and #p1/#p2/#p3'
    };

    this.controller.reactionHandler = async (comment: vscode.Comment, reaction: vscode.CommentReaction) => {
      if (!(comment instanceof NoteComment)) return;
      const author = this.getUsername();
      await this.storage.toggleReaction(comment.fctThreadId, comment.fctId, reaction.label, author);
      
      // Refresh the specific thread UI
      await this.refreshThreadFromStorage(comment.fctThreadId);
    };
  }

  /**
   * Get the username from settings.
   */
  private getUsername(): string {
    const config = vscode.workspace.getConfiguration('fct');
    const username = config.get<string>('username', '');
    if (username) { return username; }

    // Fallback to OS username or 'Anonymous'
    return process.env.USER || process.env.USERNAME || 'Anonymous';
  }

  /**
   * Parse @mentions from a comment body.
   */
  private parseMentions(body: string): string[] {
    const regex = /@(\w+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      mentions.push(match[1]);
    }
    return [...new Set(mentions)]; // deduplicate
  }

  /**
   * Helper to create a NoteComment and apply styling (severity label, strikeout).
   */
  private createNoteComment(fctComment: FCTComment, threadStatus: string): NoteComment {
    let bodyText = fctComment.body;
    let label: string | undefined = undefined;

    // Parse severity
    const severityMatch = bodyText.match(/#(p[1-3])/i);
    if (severityMatch) {
      const severity = severityMatch[1].toLowerCase();
      if (severity === 'p1') label = '🔴 P1';
      else if (severity === 'p2') label = '🟡 P2';
      else if (severity === 'p3') label = '🔵 P3';
    }

    // Parse other tags
    if (!label) {
      if (bodyText.match(/#todo\b/i)) label = '📋 TODO';
      else if (bodyText.match(/#bug\b/i)) label = '🐛 BUG';
      else if (bodyText.match(/#idea\b/i)) label = '💡 IDEA';
    }

    // Highlight severity tags, mentions, and other tags in markdown
    bodyText = bodyText.replace(/(#p[1-3])\b/gi, '**$1**');
    bodyText = bodyText.replace(/(#(?:todo|bug|idea))\b/gi, '**$1**');
    bodyText = bodyText.replace(/(@\w+)\b/g, '**$1**');

    // Apply strikeout if resolved
    if (threadStatus === 'resolved') {
      bodyText = `~~${bodyText}~~`;
    }

    const comment = new NoteComment(
      new vscode.MarkdownString(bodyText),
      vscode.CommentMode.Preview,
      { name: fctComment.author },
      fctComment.author === this.getUsername() ? 'canEdit' : '',
      fctComment.id,
      fctComment.threadId,
      new Date(fctComment.createdAt),
    );
    comment.label = label;

    // Convert FCT reactions to VS Code CommentReactions, injecting defaults
    const currentUser = this.getUsername();
    const availableLabels = ['👍', '👎', '🚀', '👀', '🎉'];
    const reactionMap = new Map<string, vscode.CommentReaction>();
    
    for (const l of availableLabels) {
      reactionMap.set(l, { label: l, count: 0, authorHasReacted: false, iconPath: '' });
    }

    if (fctComment.reactions) {
      for (const r of fctComment.reactions) {
        reactionMap.set(r.label, {
          label: r.label,
          count: r.authors.length,
          authorHasReacted: r.authors.includes(currentUser),
          iconPath: ''
        });
      }
    }

    comment.reactions = Array.from(reactionMap.values());

    return comment;
  }

  // ─── Command Handlers ───────────────────────────────────────────

  /**
   * Create an empty thread from editor selection (context menu action).
   */
  createEmptyThread(editor: vscode.TextEditor): void {
    const range = editor.selection;
    const uri = editor.document.uri;
    const vsThread = this.controller.createCommentThread(uri, range, []);
    vsThread.canReply = true;
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /**
   * Handle the "Add Comment" command.
   * Called when the user types in the new comment input box and submits.
   */
  async addComment(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread;
    const document = await vscode.workspace.openTextDocument(thread.uri);
    let body = reply.text;
    
    // Resolve @author dynamically using Git blame
    if (body.includes('@author')) {
      const startLine = thread.range ? thread.range.start.line + 1 : 1;
      const blameName = this.gitService.getBlameAuthor(document.uri, startLine);
      if (blameName) {
        const mentionName = blameName.replace(/\s+/g, '');
        body = body.replace(/@author/g, `@${mentionName}`);
      } else {
        body = body.replace(/@author/g, `@unknown`);
      }
    }

    const author = this.getUsername();
    const mentions = this.parseMentions(body);

    // Check if this is a reply to an existing FCT thread
    const existingFctId = this.vsThreadToFctId.get(thread);

    if (existingFctId) {
      // This is a reply to an existing thread
      await this.replyToThread(thread, existingFctId, body, author, mentions);
    } else {
      // This is a new thread
      await this.createNewThread(thread, document, body, author, mentions);
    }
  }

  /**
   * Create a new FCT comment thread from a VS Code comment thread.
   */
  private async createNewThread(
    vsThread: vscode.CommentThread,
    document: vscode.TextDocument,
    body: string,
    author: string,
    mentions: string[]
  ): Promise<void> {
    const uri = document.uri;
    const range = vsThread.range ?? new vscode.Range(0, 0, 0, 0);

    // Get Git context
    const repoId = this.gitService.getRepoId(uri);
    const commitHash = this.gitService.getCurrentCommitHash(uri) || 'HEAD';
    const branchName = this.gitService.getCurrentBranch(uri) || 'unknown';
    const filePath = this.gitService.getRelativePath(uri);

    // Capture the selected code as a snippet
    const codeSnippet = document.getText(range);

    // Create the thread in storage
    const payload: CreateThreadPayload = {
      repoId,
      filePath,
      commitHash,
      branchName,
      originalStartLine: range.start.line + 1, // Convert to 1-indexed
      originalStartChar: range.start.character,
      originalEndLine: range.end.line + 1,
      originalEndChar: range.end.character,
      codeSnippet,
      comment: { author, body, mentions },
    };

    const fctThread = await this.storage.createThread(payload);

    // Create the NoteComment for the VS Code UI
    const noteComment = this.createNoteComment(fctThread.comments[0], fctThread.status);

    // Update the VS Code thread
    vsThread.comments = [noteComment];
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    vsThread.canReply = true;
    vsThread.label = fctThread.status === 'resolved' ? '✅ Resolved' : undefined;
    vsThread.contextValue = fctThread.status === 'resolved' ? 'resolved' : 'active';

    // Track the mapping
    this.vsThreadToFctId.set(vsThread, fctThread.id);
    this.fctIdToVsThread.set(fctThread.id, vsThread);
  }

  /**
   * Reply to an existing FCT thread.
   */
  private async replyToThread(
    vsThread: vscode.CommentThread,
    fctThreadId: string,
    body: string,
    author: string,
    mentions: string[]
  ): Promise<void> {
    const payload: CreateReplyPayload = { author, body, mentions };
    const fctComment = await this.storage.addReply(fctThreadId, payload);

    const noteComment = this.createNoteComment(fctComment, 'active');

    vsThread.comments = [...vsThread.comments, noteComment];
  }

  /**
   * Handle "Edit Comment" — switch to editing mode.
   */
  editComment(comment: NoteComment): void {
    if (comment instanceof NoteComment) {
      comment.savedBody = comment.body;
      comment.mode = vscode.CommentMode.Editing;
      comment.contextValue = 'editing';

      // Force UI refresh by updating the thread's comments array
      this.refreshCommentInThread(comment);
    }
  }

  /**
   * Handle "Save Edit" — persist the edited comment.
   */
  async saveEdit(comment: NoteComment): Promise<void> {
    if (!(comment instanceof NoteComment)) { return; }

    let bodyText = typeof comment.body === 'string'
      ? comment.body
      : comment.body.value;
      
    const fctThread = await this.storage.loadThread(comment.fctThreadId);
    if (!fctThread) return;

    // Resolve @author dynamically
    if (bodyText.includes('@author')) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const rootUri = workspaceFolders[0].uri;
        const uri = vscode.Uri.joinPath(rootUri, fctThread.filePath);
        
        const blameName = this.gitService.getBlameAuthor(uri, fctThread.currentStartLine);
        if (blameName) {
          const mentionName = blameName.replace(/\s+/g, '');
          bodyText = bodyText.replace(/@author/g, `@${mentionName}`);
        } else {
          bodyText = bodyText.replace(/@author/g, `@unknown`);
        }
      }
    }

    const mentions = this.parseMentions(bodyText);

    await this.storage.updateComment(
      comment.fctThreadId,
      comment.fctId,
      bodyText,
      mentions
    );

    const status = fctThread.status;
    const newNoteComment = this.createNoteComment({
      id: comment.fctId,
      threadId: comment.fctThreadId,
      author: comment.author.name,
      body: bodyText,
      mentions: [],
      createdAt: comment.timestamp ? comment.timestamp.toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, status);

    comment.body = newNoteComment.body;
    comment.label = newNoteComment.label;
    comment.savedBody = comment.body;
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = 'canEdit';

    this.refreshCommentInThread(comment);
  }

  /**
   * Handle "Cancel Edit" — revert to saved body.
   */
  cancelEdit(comment: NoteComment): void {
    if (!(comment instanceof NoteComment)) { return; }

    comment.body = comment.savedBody;
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = 'canEdit';

    this.refreshCommentInThread(comment);
  }

  /**
   * Handle "Delete Comment" — remove a single comment.
   */
  async deleteComment(comment: NoteComment): Promise<void> {
    if (!(comment instanceof NoteComment)) { return; }

    await this.storage.deleteComment(comment.fctThreadId, comment.fctId);

    // Find the VS Code thread
    const vsThread = this.fctIdToVsThread.get(comment.fctThreadId);
    if (!vsThread) { return; }

    const remaining = vsThread.comments.filter(c => {
      if (c instanceof NoteComment) {
        return c.fctId !== comment.fctId;
      }
      return true;
    });

    if (remaining.length === 0) {
      // Last comment deleted — dispose the entire thread
      this.vsThreadToFctId.delete(vsThread);
      this.fctIdToVsThread.delete(comment.fctThreadId);
      vsThread.dispose();
    } else {
      vsThread.comments = remaining;
    }
  }

  /**
   * Handle "Delete Thread" — remove the entire thread.
   */
  async deleteThread(vsThread: vscode.CommentThread): Promise<void> {
    const fctId = this.vsThreadToFctId.get(vsThread);
    if (fctId) {
      await this.storage.deleteThread(fctId);
      this.fctIdToVsThread.delete(fctId);
    }
    this.vsThreadToFctId.delete(vsThread);
    vsThread.dispose();
  }

  /**
   * Handle "Resolve Thread" — mark as resolved.
   */
  async resolveThread(vsThread: vscode.CommentThread): Promise<void> {
    const fctId = this.vsThreadToFctId.get(vsThread);
    if (fctId) {
      await this.storage.updateThreadStatus(fctId, 'resolved');
      this.refreshThreadFromStorage(fctId);
    }

    vsThread.contextValue = 'resolved';
    vsThread.label = '✅ Resolved';
    // Collapse resolved threads
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  }

  /**
   * Handle "Unresolve Thread" — re-open a resolved thread.
   */
  async unresolveThread(vsThread: vscode.CommentThread): Promise<void> {
    const fctId = this.vsThreadToFctId.get(vsThread);
    if (fctId) {
      await this.storage.updateThreadStatus(fctId, 'active');
      this.refreshThreadFromStorage(fctId);
    }

    vsThread.contextValue = 'active';
    vsThread.label = undefined;
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  // ─── Loading & Restoring ──────────────────────────────────────────

  /**
   * Load and render all comment threads for a given document.
   * Applies anchoring to adjust line positions if the commit has changed.
   */
  async loadCommentsForDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') { return; }

    const uri = document.uri;
    const repoId = this.gitService.getRepoId(uri);
    const filePath = this.gitService.getRelativePath(uri);
    const currentCommit = this.gitService.getCurrentCommitHash(uri) || 'HEAD';

    // Fetch threads from storage
    const threads = await this.storage.loadThreadsByFile(repoId, filePath);
    if (threads.length === 0) { return; }

    // Check if git anchoring is enabled
    const enableAnchoring = vscode.workspace
      .getConfiguration('fct')
      .get<boolean>('enableGitAnchoring', true);
      
    const autoResolve = vscode.workspace
      .getConfiguration('fct')
      .get<boolean>('autoResolveOrphans', false);

    // Anchor and render each thread
    let anchorResults: Map<string, { newStartLine: number; newEndLine: number; newStartChar?: number; newEndChar?: number; orphaned: boolean }> | undefined;

    if (enableAnchoring && currentCommit !== 'HEAD') {
      anchorResults = await this.anchoringEngine.anchorThreads(threads, document, currentCommit);
    }

    for (const fctThread of threads) {
      // Skip if we already have this thread rendered
      if (this.fctIdToVsThread.has(fctThread.id)) {
        continue;
      }

      // Determine the display range
      let startLine = fctThread.originalStartLine - 1; // 0-indexed
      let endLine = fctThread.originalEndLine - 1;
      let startChar = fctThread.originalStartChar ?? 0;
      let endChar = fctThread.originalEndChar ?? 0;
      
      let isOrphaned = false;

      if (anchorResults) {
        const anchor = anchorResults.get(fctThread.id);
        if (anchor) {
          if (anchor.orphaned) {
            isOrphaned = true;
            
            // Auto-resolve logic
            if (autoResolve && fctThread.status !== 'resolved') {
              fctThread.status = 'resolved';
              const sysReply = {
                author: 'FCT System',
                body: 'Automatically resolved because the underlying code was removed.',
                mentions: []
              };
              
              // Update state optimistically
              fctThread.comments.push({
                id: 'temp-' + Date.now(),
                threadId: fctThread.id,
                body: sysReply.body,
                author: sysReply.author,
                mentions: sysReply.mentions,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              });
              
              // Fire & forget storage updates
              this.storage.updateThreadStatus(fctThread.id, 'resolved');
              this.storage.addReply(fctThread.id, sysReply);
            }
          } else {
            startLine = anchor.newStartLine - 1;
            endLine = anchor.newEndLine - 1;
            // Anchor engine returns characters if it was an exact pure line shift.
            // If fuzzy, it sets them to undefined, so we use 0 -> line.length
            if (anchor.newStartChar !== undefined && anchor.newEndChar !== undefined) {
              startChar = anchor.newStartChar;
              endChar = anchor.newEndChar;
            } else {
              startChar = 0;
              endChar = document.lineAt(Math.max(0, Math.min(endLine, document.lineCount - 1))).text.length;
            }
          }
        }
      }

      // Clamp to document bounds
      startLine = Math.max(0, Math.min(startLine, document.lineCount - 1));
      endLine = Math.max(startLine, Math.min(endLine, document.lineCount - 1));

      // Re-clamp characters if they exceed the line
      if (!isOrphaned || !anchorResults) {
        const lineTextStart = document.lineAt(startLine).text;
        const lineTextEnd = document.lineAt(endLine).text;
        startChar = Math.max(0, Math.min(startChar, lineTextStart.length));
        endChar = Math.max(0, Math.min(endChar, lineTextEnd.length));
      }

      // Final fallback if endChar is 0 and startLine != endLine or startChar == 0
      // If we don't have valid characters, select the whole block
      if (startChar === 0 && endChar === 0) {
        endChar = document.lineAt(endLine).text.length;
      }

      const range = new vscode.Range(
        new vscode.Position(startLine, startChar),
        new vscode.Position(endLine, endChar)
      );

      // Convert FCT comments to NoteComments
      const noteComments = fctThread.comments.map(c => this.createNoteComment(c, fctThread.status));

      // Create the VS Code thread
      const vsThread = this.controller.createCommentThread(
        document.uri,
        range,
        noteComments
      );

      // Configure thread properties
      vsThread.canReply = true;

      if (isOrphaned || fctThread.status === 'orphaned') {
        vsThread.contextValue = 'orphaned';
        vsThread.label = '⚠️ Orphaned — code was modified or deleted';
        vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      } else if (fctThread.status === 'resolved') {
        vsThread.contextValue = 'resolved';
        vsThread.label = '✅ Resolved';
        vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      } else {
        vsThread.contextValue = 'active';
        vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }

      // Track mappings
      this.vsThreadToFctId.set(vsThread, fctThread.id);
      this.fctIdToVsThread.set(fctThread.id, vsThread);
    }
  }

  /**
   * Handle a real-time WebSocket message — update the UI accordingly.
   */
  handleWSMessage(message: { type: string; threadId: string; filePath: string; data: unknown }): void {
    switch (message.type) {
      case 'comment_created':
      case 'comment_updated':
        // Refresh the thread from storage
        this.refreshThreadFromStorage(message.threadId);
        break;
      case 'comment_deleted':
        this.refreshThreadFromStorage(message.threadId);
        break;
      case 'thread_resolved':
        this.updateThreadUI(message.threadId, 'resolved');
        break;
      case 'thread_orphaned':
        this.updateThreadUI(message.threadId, 'orphaned');
        break;
    }
  }

  /**
   * Refresh a thread's UI from storage data.
   */
  private async refreshThreadFromStorage(threadId: string): Promise<void> {
    const fctThread = await this.storage.loadThread(threadId);
    if (!fctThread) {
      // Thread was deleted
      const vsThread = this.fctIdToVsThread.get(threadId);
      if (vsThread) {
        this.vsThreadToFctId.delete(vsThread);
        this.fctIdToVsThread.delete(threadId);
        vsThread.dispose();
      }
      return;
    }

    const vsThread = this.fctIdToVsThread.get(threadId);
    if (vsThread) {
      // Update comments
      const noteComments = fctThread.comments.map(c => this.createNoteComment(c, fctThread.status));
      vsThread.comments = noteComments;
    }
  }

  /**
   * Update a thread's visual status.
   */
  private updateThreadUI(threadId: string, status: string): void {
    const vsThread = this.fctIdToVsThread.get(threadId);
    if (!vsThread) { return; }

    if (status === 'resolved') {
      vsThread.contextValue = 'resolved';
      vsThread.label = '✅ Resolved';
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    } else if (status === 'orphaned') {
      vsThread.contextValue = 'orphaned';
      vsThread.label = '⚠️ Orphaned — code was modified or deleted';
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    } else {
      vsThread.contextValue = 'active';
      vsThread.label = undefined;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  /**
   * Force a UI refresh for a comment by re-setting the thread's comments array.
   * This is necessary because VS Code doesn't observe property changes on Comment objects.
   */
  private refreshCommentInThread(comment: NoteComment): void {
    const vsThread = this.fctIdToVsThread.get(comment.fctThreadId);
    if (vsThread) {
      vsThread.comments = [...vsThread.comments];
    }
  }

  /**
   * Clear all rendered threads (e.g., on deactivation).
   */
  clearAll(): void {
    for (const vsThread of this.fctIdToVsThread.values()) {
      vsThread.dispose();
    }
    this.vsThreadToFctId.clear();
    this.fctIdToVsThread.clear();
  }

  /**
   * Hover provider integration. Displays comments when hovering over the anchored code.
   */
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const hovers: vscode.MarkdownString[] = [];

    for (const vsThread of this.fctIdToVsThread.values()) {
      if (vsThread.uri.toString() === document.uri.toString() && vsThread.range) {
        if (vsThread.range.contains(position)) {
          const md = new vscode.MarkdownString();
          // Do NOT set isTrusted=true here — comment bodies contain user input
          // and trusted MarkdownStrings allow command: links to execute arbitrary commands.
          md.appendMarkdown(`**💬 FCT Thread** ${vsThread.contextValue === 'resolved' ? '(✅ Resolved)' : ''}\n\n`);
          
          for (const comment of vsThread.comments) {
            const bodyText = typeof comment.body === 'string' ? comment.body : comment.body.value;
            md.appendMarkdown(`**${comment.author.name}**: ${bodyText}\n\n`);
          }
          hovers.push(md);
        }
      }
    }

    if (hovers.length > 0) {
      return new vscode.Hover(hovers);
    }
    return null;
  }

  /**
   * Get the underlying CommentController (for disposal).
   */
  getController(): vscode.CommentController {
    return this.controller;
  }

  dispose(): void {
    this.clearAll();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.controller.dispose();
  }
}
