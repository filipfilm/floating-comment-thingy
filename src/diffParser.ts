/**
 * Unified diff parser.
 * Parses the output of `git diff` into structured hunk data,
 * and provides line mapping functions for comment anchoring.
 */

import { DiffHunk, DiffChange } from './types';

/**
 * Parse a unified diff string into an array of DiffHunks.
 *
 * Handles the standard unified diff format:
 *   @@ -oldStart,oldLines +newStart,newLines @@
 *   context lines (space prefix)
 *   deleted lines (- prefix)
 *   added lines (+ prefix)
 */
export function parseDiff(diffString: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffString.split('\n');
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const hunkHeaderRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  for (const line of lines) {
    const headerMatch = line.match(hunkHeaderRegex);

    if (headerMatch) {
      // Start a new hunk
      currentHunk = {
        oldStart: parseInt(headerMatch[1], 10),
        oldLines: headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1,
        newStart: parseInt(headerMatch[3], 10),
        newLines: headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1,
        changes: [],
      };
      hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith('+')) {
      // Added line
      currentHunk.changes.push({
        type: 'add',
        newLine: newLine,
        content: line.substring(1),
      });
      newLine++;
    } else if (line.startsWith('-')) {
      // Deleted line
      currentHunk.changes.push({
        type: 'delete',
        oldLine: oldLine,
        content: line.substring(1),
      });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      // Context line
      currentHunk.changes.push({
        type: 'context',
        oldLine: oldLine,
        newLine: newLine,
        content: line.startsWith(' ') ? line.substring(1) : line,
      });
      oldLine++;
      newLine++;
    }
    // Ignore \ No newline at end of file and other noise
  }

  return hunks;
}

/**
 * Map an original line range to a new line range using diff hunks.
 *
 * Walks through the hunks and computes the cumulative offset at the
 * comment's original position. If the lines were deleted, returns null.
 *
 * @param hunks - Parsed diff hunks
 * @param oldStart - Original start line (1-indexed)
 * @param oldEnd - Original end line (1-indexed)
 * @returns New line range, or null if the range was fully deleted
 */
export function mapLineRange(
  hunks: DiffHunk[],
  oldStart: number,
  oldEnd: number
): { newStart: number; newEnd: number } | null {
  let offset = 0;
  let startDeleted = false;
  let endDeleted = false;

  for (const hunk of hunks) {
    const hunkOldEnd = hunk.oldStart + hunk.oldLines - 1;

    // Hunk is entirely before the comment range — just accumulate offset
    if (hunkOldEnd < oldStart) {
      offset += (hunk.newLines - hunk.oldLines);
      continue;
    }

    // Hunk is entirely after the comment range — done
    if (hunk.oldStart > oldEnd) {
      break;
    }

    // Hunk overlaps with the comment range — need to examine individual changes
    let localOldLine = hunk.oldStart;
    let localNewLine = hunk.newStart;
    let deletedInRange = 0;
    let totalInRange = 0;

    for (const change of hunk.changes) {
      if (change.type === 'delete') {
        if (localOldLine >= oldStart && localOldLine <= oldEnd) {
          deletedInRange++;
          totalInRange++;
        }
        if (localOldLine === oldStart) { startDeleted = true; }
        if (localOldLine === oldEnd) { endDeleted = true; }
        localOldLine++;
      } else if (change.type === 'add') {
        localNewLine++;
      } else {
        // context
        if (localOldLine >= oldStart && localOldLine <= oldEnd) {
          totalInRange++;
        }
        localOldLine++;
        localNewLine++;
      }
    }

    // If every line in the range was deleted, mark as fully deleted
    const rangeSize = oldEnd - oldStart + 1;
    if (deletedInRange >= rangeSize) {
      return null;
    }

    // Compute final offset from this hunk
    offset += (hunk.newLines - hunk.oldLines);
  }

  const newStart = oldStart + offset;
  const newEnd = oldEnd + offset;

  // Sanity: ensure positive line numbers
  if (newStart < 1 || newEnd < 1) {
    return null;
  }

  return { newStart, newEnd };
}

/**
 * Compute similarity ratio between two strings using a simple
 * character-level comparison (Sørensen–Dice coefficient on bigrams).
 *
 * @returns A number between 0 and 1, where 1 means identical
 */
export function similarity(a: string, b: string): number {
  if (a === b) { return 1; }
  if (a.length < 2 || b.length < 2) { return 0; }

  const aBigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    aBigrams.set(bigram, (aBigrams.get(bigram) || 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    const count = aBigrams.get(bigram) || 0;
    if (count > 0) {
      aBigrams.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2 * intersectionSize) / ((a.length - 1) + (b.length - 1));
}

/**
 * Fuzzy-search for a code snippet in a document's text.
 * Returns the best-matching line range, or null if no good match.
 *
 * @param documentText - Full text of the document
 * @param snippet - The code snippet to search for
 * @param minSimilarity - Minimum similarity threshold (default 0.7)
 * @returns Line range (1-indexed) of the best match, or null
 */
export function fuzzyFindSnippet(
  documentText: string,
  snippet: string,
  minSimilarity: number = 0.7
): { startLine: number; endLine: number } | null {
  const docLines = documentText.split('\n');
  const snippetLines = snippet.split('\n');
  const snippetLineCount = snippetLines.length;

  if (snippetLineCount === 0 || docLines.length === 0) {
    return null;
  }

  let bestSimilarity = 0;
  let bestStart = -1;

  // Slide a window of snippetLineCount lines across the document
  for (let i = 0; i <= docLines.length - snippetLineCount; i++) {
    const windowText = docLines.slice(i, i + snippetLineCount).join('\n');
    const sim = similarity(windowText, snippet);

    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestStart = i;
    }
  }

  if (bestSimilarity >= minSimilarity && bestStart >= 0) {
    return {
      startLine: bestStart + 1,   // convert to 1-indexed
      endLine: bestStart + snippetLineCount,
    };
  }

  return null;
}
