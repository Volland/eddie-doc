import * as vscode from "vscode";
import type { ReviewItem } from "../model/types.js";
import { effectiveLine } from "../matching/mapper.js";
import { locate } from "../matching/align.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** The line span an item covers in the current document. */
function spanLines(
  item: ReviewItem,
  document: vscode.TextDocument
): { start: number; end: number } | null {
  const start = effectiveLine(item);
  if (start === UNMATCHED || start >= document.lineCount) return null;
  const end = Math.min(
    item.manualLine != null ? start : item.match?.endLine ?? start,
    document.lineCount - 1
  );
  return { start, end: Math.max(start, end) };
}

function spanRange(
  lines: { start: number; end: number },
  document: vscode.TextDocument
): vscode.Range {
  return new vscode.Range(
    new vscode.Position(lines.start, 0),
    document.lineAt(lines.end).range.end
  );
}

/**
 * Resolve the exact character range of an annotation's marked text within the
 * source, or null if it can't be pinned down confidently (caller falls back to
 * line-level). Uses the tight `markedText`, else the generous `anchoredText`.
 */
export function resolveMarkedRange(
  document: vscode.TextDocument,
  item: ReviewItem
): vscode.Range | null {
  const lines = spanLines(item, document);
  if (!lines) return null;
  const needle = item.markedText || item.anchoredText;
  if (!needle) return null;

  const range = spanRange(lines, document);
  const raw = document.getText(range);
  const hit = locate(needle, raw);
  if (!hit) return null;

  const base = document.offsetAt(range.start);
  return new vscode.Range(
    document.positionAt(base + hit.start),
    document.positionAt(base + hit.end)
  );
}

/**
 * Resolve the exact insertion point for a caret/insert mark: just after the
 * text that lay to its left on the same line. Falls back to end-of-line, then
 * null if even the line can't be resolved.
 */
export function resolveInsertPosition(
  document: vscode.TextDocument,
  item: ReviewItem
): vscode.Position | null {
  const lines = spanLines(item, document);
  if (!lines) return null;
  const lineRange = new vscode.Range(
    new vscode.Position(lines.start, 0),
    document.lineAt(lines.start).range.end
  );
  const raw = document.getText(lineRange);
  const base = document.offsetAt(lineRange.start);

  if (item.beforeText) {
    const hit = locate(item.beforeText, raw);
    if (hit) return document.positionAt(base + hit.end);
  }
  return document.lineAt(lines.start).range.end;
}
