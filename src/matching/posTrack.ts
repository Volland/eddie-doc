/**
 * Live line-anchor tracking. When the user edits the source, annotation line
 * anchors must move with the text so every command (reveal, decorations, precise
 * replace/insert, re-select) keeps pointing at the right place *between* saves —
 * before the content re-match on save reconciles them.
 *
 * These are pure functions over line numbers so they can be unit-tested without
 * VS Code. The extension adapts `TextDocumentContentChangeEvent`s into
 * `ContentChange`s and feeds them here.
 */

/** A text edit reduced to what line tracking needs (pre-edit coordinates). */
export interface ContentChange {
  /** `range.start.line` before the edit. */
  startLine: number;
  /** `range.end.line` before the edit. */
  endLine: number;
  /** Number of newlines in the replacement text (0 for single-line inserts). */
  newLineCount: number;
}

/** Newlines contained in a replacement string. */
export function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function shiftOne(line: number, ch: ContentChange): number {
  const removed = ch.endLine - ch.startLine;
  const delta = ch.newLineCount - removed;
  if (delta === 0) return line;
  // At or above where the edit begins: unaffected (the edit's first line stays).
  if (line <= ch.startLine) return line;
  // Strictly below the edited region: shift by the net lines added/removed.
  if (line > ch.endLine) return line + delta;
  // Inside a replaced/deleted region: the exact line is gone — collapse it to
  // the end of what replaced it. The save-time content re-match will refine it.
  return ch.startLine + ch.newLineCount;
}

/**
 * Shift a 0-based line anchor through a batch of changes. VS Code delivers the
 * changes of one event in reverse document order and non-overlapping, so
 * applying them sequentially against the original line is correct.
 */
export function shiftLine(line: number, changes: ContentChange[]): number {
  let l = line;
  for (const ch of changes) l = shiftOne(l, ch);
  return l < 0 ? 0 : l;
}
