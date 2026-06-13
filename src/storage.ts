/**
 * Storage layer abstraction for FCT comments.
 * Provides local (workspaceState) and backend (REST API) storage implementations.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  FCTThread,
  FCTComment,
  CreateThreadPayload,
  CreateReplyPayload,
} from './types';

function getStorageFile(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;
  return path.join(rootPath, '.fct', 'comments.json');
}

// ─── Storage Interface ───────────────────────────────────────────────

export interface ICommentStorage {
  /** Save or update a thread */
  saveThread(thread: FCTThread): Promise<void>;

  /** Load all threads for a given file path */
  loadThreadsByFile(repoId: string, filePath: string): Promise<FCTThread[]>;

  /** Load all threads in the repository */
  loadAllThreads(repoId: string): Promise<FCTThread[]>;

  /** Load a single thread by ID */
  loadThread(threadId: string): Promise<FCTThread | undefined>;

  /** Delete a thread */
  deleteThread(threadId: string): Promise<void>;

  /** Create a new thread with its first comment */
  createThread(payload: CreateThreadPayload): Promise<FCTThread>;

  /** Add a reply to an existing thread */
  addReply(threadId: string, payload: CreateReplyPayload): Promise<FCTComment>;

  /** Update a comment body */
  updateComment(threadId: string, commentId: string, body: string, mentions: string[]): Promise<void>;

  /** Delete a single comment from a thread */
  deleteComment(threadId: string, commentId: string): Promise<void>;

  /** Toggle a reaction on a comment */
  toggleReaction(threadId: string, commentId: string, reactionLabel: string, author: string): Promise<void>;

  /** Update thread status (resolve, unresolve, orphan) */
  updateThreadStatus(threadId: string, status: 'active' | 'resolved' | 'orphaned'): Promise<void>;
}

// ─── Local Storage (workspaceState) ──────────────────────────────────

export class LocalStorage implements ICommentStorage {
  private threads: Map<string, FCTThread> = new Map();
  private storageFile: string | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.storageFile = getStorageFile();
  }

  async initialize(): Promise<void> {
    await this.loadFromFile();
  }

  private async loadFromFile(): Promise<void> {
    if (!this.storageFile) return;
    try {
      const data = await fs.readFile(this.storageFile, 'utf8');
      const raw = JSON.parse(data) as Record<string, FCTThread>;
      this.threads = new Map(Object.entries(raw));
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[FCT] Failed to load comments from file:', err);
      }
      this.threads = new Map();
    }
  }

  private async persist(): Promise<void> {
    if (!this.storageFile) return;
    try {
      const dir = path.dirname(this.storageFile);
      await fs.mkdir(dir, { recursive: true });

      const obj: Record<string, FCTThread> = {};
      for (const [key, val] of this.threads) {
        obj[key] = val;
      }
      await fs.writeFile(this.storageFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[FCT] Failed to save comments to file:', err);
    }
  }

  async saveThread(thread: FCTThread): Promise<void> {
    this.threads.set(thread.id, thread);
    await this.persist();
  }

  async loadThreadsByFile(repoId: string, filePath: string): Promise<FCTThread[]> {
    const results: FCTThread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.filePath === filePath && thread.repoId === repoId) {
        results.push(thread);
      }
    }
    return results;
  }

  async loadAllThreads(repoId: string): Promise<FCTThread[]> {
    const results: FCTThread[] = [];
    for (const thread of this.threads.values()) {
      if (thread.repoId === repoId) {
        results.push(thread);
      }
    }
    return results;
  }

  async loadThread(threadId: string): Promise<FCTThread | undefined> {
    return this.threads.get(threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    await this.persist();
  }

  async createThread(payload: CreateThreadPayload): Promise<FCTThread> {
    const now = new Date().toISOString();
    const threadId = generateId();
    const commentId = generateId();

    const thread: FCTThread = {
      id: threadId,
      repoId: payload.repoId,
      filePath: payload.filePath,
      commitHash: payload.commitHash,
      branchName: payload.branchName,
      originalStartLine: payload.originalStartLine,
      originalStartChar: payload.originalStartChar,
      originalEndLine: payload.originalEndLine,
      originalEndChar: payload.originalEndChar,
      currentStartLine: payload.originalStartLine,
      currentEndLine: payload.originalEndLine,
      codeSnippet: payload.codeSnippet,
      status: 'active',
      comments: [
        {
          id: commentId,
          threadId,
          body: payload.comment.body,
          author: payload.comment.author,
          mentions: payload.comment.mentions,
          createdAt: now,
          updatedAt: now,
          reactions: []
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    this.threads.set(threadId, thread);
    await this.persist();
    return thread;
  }

  async addReply(threadId: string, payload: CreateReplyPayload): Promise<FCTComment> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const now = new Date().toISOString();
    const comment: FCTComment = {
      id: generateId(),
      threadId,
      body: payload.body,
      author: payload.author,
      mentions: payload.mentions,
      createdAt: now,
      updatedAt: now,
      reactions: []
    };

    thread.comments.push(comment);
    thread.updatedAt = now;
    await this.persist();
    return comment;
  }

  async updateComment(threadId: string, commentId: string, body: string, mentions: string[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) { return; }

    const comment = thread.comments.find(c => c.id === commentId);
    if (comment) {
      comment.body = body;
      comment.mentions = mentions;
      comment.updatedAt = new Date().toISOString();
      thread.updatedAt = comment.updatedAt;
      await this.persist();
    }
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) { return; }

    thread.comments = thread.comments.filter(c => c.id !== commentId);
    if (thread.comments.length === 0) {
      this.threads.delete(threadId);
    } else {
      thread.updatedAt = new Date().toISOString();
    }
    await this.persist();
  }

  async toggleReaction(threadId: string, commentId: string, reactionLabel: string, author: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) { return; }

    const comment = thread.comments.find(c => c.id === commentId);
    if (!comment) { return; }

    comment.reactions = comment.reactions || [];
    const reaction = comment.reactions.find(r => r.label === reactionLabel);
    
    if (reaction) {
      if (reaction.authors.includes(author)) {
        reaction.authors = reaction.authors.filter(a => a !== author);
        if (reaction.authors.length === 0) {
          comment.reactions = comment.reactions.filter(x => x.label !== reactionLabel);
        }
      } else {
        reaction.authors.push(author);
      }
    } else {
      comment.reactions.push({ label: reactionLabel, authors: [author] });
    }

    thread.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async updateThreadStatus(threadId: string, status: 'active' | 'resolved' | 'orphaned'): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) { return; }

    thread.status = status;
    thread.updatedAt = new Date().toISOString();
    await this.persist();
  }
}

// ─── Backend Storage (REST API) ──────────────────────────────────────

export class BackendStorage implements ICommentStorage {
  private baseUrl: string;
  private fallback: LocalStorage;

  constructor(baseUrl: string, fallback: LocalStorage) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fallback = fallback;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        throw new Error(`Backend error: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);
    } catch (error) {
      console.warn(`[FCT] Backend request failed for ${path}, falling back to local storage:`, error);
      throw error;
    }
  }

  async saveThread(thread: FCTThread): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${thread.id}`, {
        method: 'PUT',
        body: JSON.stringify(thread),
      });
    } catch {
      await this.fallback.saveThread(thread);
    }
  }

  async loadThreadsByFile(repoId: string, filePath: string): Promise<FCTThread[]> {
    try {
      return await this.request<FCTThread[]>(
        `/api/v1/comments?file=${encodeURIComponent(filePath)}&repo=${encodeURIComponent(repoId)}`
      );
    } catch {
      return this.fallback.loadThreadsByFile(repoId, filePath);
    }
  }

  async loadAllThreads(repoId: string): Promise<FCTThread[]> {
    try {
      return await this.request<FCTThread[]>(
        `/api/v1/comments?repo=${encodeURIComponent(repoId)}`
      );
    } catch {
      return this.fallback.loadAllThreads(repoId);
    }
  }

  async loadThread(threadId: string): Promise<FCTThread | undefined> {
    try {
      return await this.request<FCTThread>(`/api/v1/comments/${threadId}`);
    } catch {
      return this.fallback.loadThread(threadId);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${threadId}`, { method: 'DELETE' });
    } catch {
      await this.fallback.deleteThread(threadId);
    }
  }

  async createThread(payload: CreateThreadPayload): Promise<FCTThread> {
    try {
      // Flatten the nested comment into top-level fields to match backend API
      const backendPayload = {
        repoId: payload.repoId,
        filePath: payload.filePath,
        commitHash: payload.commitHash,
        branchName: payload.branchName,
        originalStartLine: payload.originalStartLine,
        originalStartChar: payload.originalStartChar,
        originalEndLine: payload.originalEndLine,
        originalEndChar: payload.originalEndChar,
        codeSnippet: payload.codeSnippet,
        author: payload.comment.author,
        body: payload.comment.body,
      };
      return await this.request<FCTThread>('/api/v1/comments', {
        method: 'POST',
        body: JSON.stringify(backendPayload),
      });
    } catch {
      return this.fallback.createThread(payload);
    }
  }

  async addReply(threadId: string, payload: CreateReplyPayload): Promise<FCTComment> {
    try {
      return await this.request<FCTComment>(`/api/v1/comments/${threadId}/replies`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch {
      return this.fallback.addReply(threadId, payload);
    }
  }

  async updateComment(threadId: string, commentId: string, body: string, mentions: string[]): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${threadId}/replies/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify({ body, mentions }),
      });
    } catch {
      await this.fallback.updateComment(threadId, commentId, body, mentions);
    }
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${threadId}/replies/${commentId}`, {
        method: 'DELETE',
      });
    } catch {
      await this.fallback.deleteComment(threadId, commentId);
    }
  }

  async toggleReaction(threadId: string, commentId: string, reactionLabel: string, author: string): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${threadId}/replies/${commentId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ label: reactionLabel, author }),
      });
    } catch {
      await this.fallback.toggleReaction(threadId, commentId, reactionLabel, author);
    }
  }

  async updateThreadStatus(threadId: string, status: 'active' | 'resolved' | 'orphaned'): Promise<void> {
    try {
      await this.request(`/api/v1/comments/${threadId}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
    } catch {
      await this.fallback.updateThreadStatus(threadId, status);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  // Crypto-quality random UUID (available in Node 16+)
  const hex = [...Array(32)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Creates the appropriate storage instance based on configuration.
 */
export async function createStorage(context: vscode.ExtensionContext): Promise<ICommentStorage> {
  const config = vscode.workspace.getConfiguration('fct');
  const backendUrl = config.get<string>('backendUrl', '');
  const local = new LocalStorage(context);
  await local.initialize();

  if (backendUrl) {
    return new BackendStorage(backendUrl, local);
  }

  return local;
}
