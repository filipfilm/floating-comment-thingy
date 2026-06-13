/**
 * Core data types for the FCT extension.
 * These mirror the backend models and are used throughout the extension.
 */

/** A single comment within a thread */
export interface FCTComment {
  id: string;
  threadId: string;
  body: string;
  author: string;
  mentions: string[];
  reactions?: FCTReaction[];
  createdAt: string;
  updatedAt: string;
}

/** A single reaction on a comment */
export interface FCTReaction {
  label: string;
  authors: string[];
}

/** A comment thread anchored to a code range */
export interface FCTThread {
  id: string;
  repoId: string;
  filePath: string;
  commitHash: string;
  branchName: string;
  originalStartLine: number; // 1-indexed line
  originalStartChar: number; // 0-indexed char
  originalEndLine: number;
  originalEndChar: number;
  currentStartLine: number;
  currentEndLine: number;
  codeSnippet: string;
  status: 'active' | 'resolved' | 'orphaned';
  comments: FCTComment[];
  createdAt: string;
  updatedAt: string;
}

/** Payload sent to the backend when creating a new thread */
export interface CreateThreadPayload {
  repoId: string;
  filePath: string;
  commitHash: string;
  branchName: string;
  originalStartLine: number;
  originalStartChar: number;
  originalEndLine: number;
  originalEndChar: number;
  codeSnippet: string;
  comment: {
    author: string;
    body: string;
    mentions: string[];
  };
}

/** Payload sent to the backend when replying to a thread */
export interface CreateReplyPayload {
  author: string;
  body: string;
  mentions: string[];
}

/** WebSocket message types from the backend */
export type WSMessageType =
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'thread_resolved'
  | 'thread_orphaned';

/** WebSocket message envelope */
export interface WSMessage {
  type: WSMessageType;
  threadId: string;
  repoId: string;
  filePath: string;
  data: FCTThread | FCTComment | null;
}

export interface AnchorResult {
  newStartLine: number;
  newEndLine: number;
  newStartChar?: number;
  newEndChar?: number;
  confidence: number;
  orphaned: boolean;
}

/** Parsed diff hunk from a unified diff */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: DiffChange[];
}

/** A single change line within a diff hunk */
export interface DiffChange {
  type: 'add' | 'delete' | 'context';
  oldLine?: number;
  newLine?: number;
  content: string;
}
