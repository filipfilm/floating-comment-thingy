/**
 * Anchoring engine — keeps comments attached to the right code
 * across commits and branch switches.
 *
 * Strategy:
 * 1. Diff-based line mapping: use unified diff hunks to compute line offsets
 * 2. Content fingerprinting: validate the mapping against the stored code snippet
 * 3. Fuzzy fallback: if diff mapping fails, search the file for the snippet
 * 4. Orphan detection: if nothing matches, mark the thread as orphaned
 */

import * as vscode from 'vscode';
import { FCTThread, AnchorResult } from './types';
import { GitService } from './gitService';
import { parseDiff, mapLineRange, similarity, fuzzyFindSnippet } from './diffParser';

/** Minimum similarity threshold for accepting a diff-mapped result */
const SIMILARITY_THRESHOLD = 0.7;

export class AnchoringEngine {
  constructor(private gitService: GitService) {}

  /**
   * Re-anchor a thread to the current state of the file.
   *
   * @param thread - The thread with its original anchoring data
   * @param document - The current document content
   * @param currentCommit - The commit the user is currently on
   * @returns Updated anchor result with new line range and confidence
   */
  async anchorThread(
    thread: FCTThread,
    document: vscode.TextDocument,
    currentCommit: string
  ): Promise<AnchorResult> {
    // If the commit hasn't changed, no remapping needed
    if (thread.commitHash === currentCommit) {
      return {
        newStartLine: thread.originalStartLine,
        newEndLine: thread.originalEndLine,
        newStartChar: thread.originalStartChar,
        newEndChar: thread.originalEndChar,
        confidence: 1.0,
        orphaned: false,
      };
    }

    // Strategy 1: Diff-based line mapping
    const diffResult = await this.tryDiffMapping(
      thread,
      document,
      currentCommit
    );
    if (diffResult) {
      return diffResult;
    }

    // Strategy 2: Fuzzy content search (fallback)
    const fuzzyResult = this.tryFuzzySearch(thread, document);
    if (fuzzyResult) {
      return fuzzyResult;
    }

    // Strategy 3: No match found — orphan
    return {
      newStartLine: thread.originalStartLine,
      newEndLine: thread.originalEndLine,
      newStartChar: thread.originalStartChar,
      newEndChar: thread.originalEndChar,
      confidence: 0,
      orphaned: true,
    };
  }

  /**
   * Strategy 1: Use git diff to compute line offsets.
   */
  private async tryDiffMapping(
    thread: FCTThread,
    document: vscode.TextDocument,
    currentCommit: string
  ): Promise<AnchorResult | null> {
    try {
      const diffString = await this.gitService.getDiff(
        document.uri,
        thread.commitHash,
        currentCommit
      );

      if (!diffString) {
        // No diff available — could be same content or git error
        // Fall through to fuzzy search
        return null;
      }

      const hunks = parseDiff(diffString);
      const mapped = mapLineRange(
        hunks,
        thread.originalStartLine,
        thread.originalEndLine
      );

      if (!mapped) {
        // Lines were deleted
        return null;
      }

      // Validate: compare text at the new range with the stored snippet
      const newText = this.getTextAtRange(
        document,
        mapped.newStart,
        mapped.newEnd
      );

      const sim = similarity(
        normalizeWhitespace(newText),
        normalizeWhitespace(thread.codeSnippet)
      );

      if (sim >= SIMILARITY_THRESHOLD) {
        return {
          newStartLine: mapped.newStart,
          newEndLine: mapped.newEnd,
          newStartChar: thread.originalStartChar,
          newEndChar: thread.originalEndChar,
          confidence: sim,
          orphaned: false,
        };
      }

      // Diff mapping didn't produce a confident result
      return null;
    } catch (error) {
      console.warn('[FCT] Diff mapping failed:', error);
      return null;
    }
  }

  /**
   * Strategy 2: Fuzzy search the document for the code snippet.
   */
  private tryFuzzySearch(
    thread: FCTThread,
    document: vscode.TextDocument
  ): AnchorResult | null {
    const documentText = document.getText();
    const match = fuzzyFindSnippet(documentText, thread.codeSnippet, SIMILARITY_THRESHOLD);

    if (match) {
      // Compute the actual similarity at the matched location
      const matchedText = this.getTextAtRange(document, match.startLine, match.endLine);
      const sim = similarity(
        normalizeWhitespace(matchedText),
        normalizeWhitespace(thread.codeSnippet)
      );

      return {
        newStartLine: match.startLine,
        newEndLine: match.endLine,
        newStartChar: undefined,
        newEndChar: undefined,
        confidence: sim,
        orphaned: false,
      };
    }

    return null;
  }

  /**
   * Re-anchor all threads for a given document.
   */
  async anchorThreads(
    threads: FCTThread[],
    document: vscode.TextDocument,
    currentCommit: string
  ): Promise<Map<string, AnchorResult>> {
    const results = new Map<string, AnchorResult>();

    for (const thread of threads) {
      const result = await this.anchorThread(thread, document, currentCommit);
      results.set(thread.id, result);
    }

    return results;
  }

  /**
   * Extract text from a document at a given line range (1-indexed).
   */
  private getTextAtRange(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number
  ): string {
    const start = Math.max(0, startLine - 1); // convert to 0-indexed
    const end = Math.min(document.lineCount - 1, endLine - 1);

    if (start > end || start >= document.lineCount) {
      return '';
    }

    const range = new vscode.Range(
      new vscode.Position(start, 0),
      new vscode.Position(end, document.lineAt(end).text.length)
    );

    return document.getText(range);
  }
}

/**
 * Normalize whitespace for comparison — collapse runs of spaces/tabs
 * to single spaces and trim lines.
 */
function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim();
}
