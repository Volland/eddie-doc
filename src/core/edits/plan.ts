/**
 * The source edits an annotation suggests, as plain offsets.
 *
 * "Apply" never runs by itself: a host asks for a plan, shows it or applies it as
 * one undoable edit in its own editor. Offsets index the source *as the editor
 * holds it*, so a host passes the live buffer, not the file on disk. Everything
 * here is the VS Code code-action logic with the editor taken out.
 */
import { locate } from "../matching/align.js";
import { itemSpan } from "../view/annotationView.js";
import { KIND_LABEL, type ReviewItem } from "../model/types.js";

/** Replace `source.slice(from, to)` with `insert`. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export type EditAction =
  | "delete-struck"
  | "delete-lines"
  | "replace-marked"
  | "insert-at-mark"
  | "insert-note";

export interface ActionInfo {
  action: EditAction;
  label: string;
  /** True when the action needs text typed by the author before it can plan. */
  needsText: boolean;
}

/** Offset of the start of each line. `starts[n]` is where line `n` begins. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineEnd(source: string, starts: number[], line: number): number {
  const next = starts[line + 1];
  if (next === undefined) return source.length;
  // Exclude the line break (and a CR before it).
  return source[next - 2] === "\r" ? next - 2 : next - 1;
}

function span(source: string, item: ReviewItem) {
  const starts = lineStarts(source);
  const s = itemSpan(item);
  if (!s || s.start >= starts.length) return null;
  const end = Math.min(s.end, starts.length - 1);
  return { starts, start: s.start, end };
}

/** Exact character range of the marked text, or null if not confidently found. */
export function markedRange(
  source: string,
  item: ReviewItem
): { from: number; to: number } | null {
  const sp = span(source, item);
  const needle = item.markedText || item.anchoredText;
  if (!sp || !needle) return null;
  const base = sp.starts[sp.start];
  const raw = source.slice(base, lineEnd(source, sp.starts, sp.end));
  const hit = locate(needle, raw);
  return hit ? { from: base + hit.start, to: base + hit.end } : null;
}

/** Where a caret/insert mark sits: just after the text to its left, else line end. */
export function insertOffset(source: string, item: ReviewItem): number | null {
  const sp = span(source, item);
  if (!sp) return null;
  const base = sp.starts[sp.start];
  const raw = source.slice(base, lineEnd(source, sp.starts, sp.start));
  if (item.beforeText) {
    const hit = locate(item.beforeText, raw);
    if (hit) return base + hit.end;
  }
  return base + raw.length;
}

/** Absorb one adjacent space so deleting a word does not leave "a  b". */
function withSpaceCleanup(source: string, r: { from: number; to: number }) {
  if (source[r.to] === " ") return { from: r.from, to: r.to + 1 };
  if (r.from > 0 && source[r.from - 1] === " ") return { from: r.from - 1, to: r.to };
  return r;
}

// @lat: [[review-pipeline#Edits from annotations]]
export function planDeleteStruck(source: string, item: ReviewItem): TextEdit | null {
  const r = markedRange(source, item);
  if (!r) return null;
  const c = withSpaceCleanup(source, r);
  return { from: c.from, to: c.to, insert: "" };
}

export function planDeleteLines(source: string, item: ReviewItem): TextEdit | null {
  const sp = span(source, item);
  if (!sp) return null;
  const from = sp.starts[sp.start];
  const to = sp.end + 1 < sp.starts.length ? sp.starts[sp.end + 1] : source.length;
  return { from, to, insert: "" };
}

export function planReplaceMarked(
  source: string,
  item: ReviewItem,
  text: string
): TextEdit | null {
  const r = markedRange(source, item);
  return r ? { from: r.from, to: r.to, insert: text } : null;
}

export function planInsertAtMark(
  source: string,
  item: ReviewItem,
  text: string
): TextEdit | null {
  const at = insertOffset(source, item);
  return at == null ? null : { from: at, to: at, insert: text };
}

/** Put the editor's note into the source as an AsciiDoc `//` comment line above. */
export function planInsertNote(source: string, item: ReviewItem): TextEdit | null {
  const sp = span(source, item);
  if (!sp || !item.comment) return null;
  const at = sp.starts[sp.start];
  const indent = /^[ \t]*/.exec(source.slice(at, lineEnd(source, sp.starts, sp.start)))?.[0] ?? "";
  const who = item.author ? `${item.author}: ` : "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const flat = item.comment.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return {
    from: at,
    to: at,
    insert: `${indent}// ✎ ${KIND_LABEL[item.kind]} — ${who}${flat}${eol}`,
  };
}

/** Which actions make sense for this annotation, in menu order. */
export function availableActions(item: ReviewItem, located: boolean): ActionInfo[] {
  if (!located) return [];
  const out: ActionInfo[] = [];
  if (item.kind === "strikeout") {
    out.push({ action: "delete-struck", label: "Delete struck text", needsText: false });
    out.push({ action: "replace-marked", label: "Replace struck text…", needsText: true });
    out.push({ action: "delete-lines", label: "Delete whole line(s)", needsText: false });
  }
  if ((item.kind === "highlight" || item.kind === "underline") && item.comment) {
    out.push({ action: "replace-marked", label: "Replace highlighted text…", needsText: true });
  }
  if (item.kind === "insert") {
    out.push({ action: "insert-at-mark", label: "Insert text at mark…", needsText: true });
  }
  if (item.comment) {
    out.push({ action: "insert-note", label: "Insert editor note as comment", needsText: false });
  }
  return out;
}

/** Apply edits to `source`. Edits must not overlap; applied last-to-first. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * The text an editor's note suggests: what is inside quotes, else the note with a
 * leading directive ("Reword:", "Replace with -") removed.
 */
export function parseSuggestion(comment: string): string {
  const c = comment.replace(/\s+/g, " ").trim();
  const q = c.match(/['"“”‘’«»]([^'"“”‘’«»]{2,})['"“”‘’«»]/);
  if (q) return q[1].trim();
  return c
    .replace(/^(reword|replace(?:\s+with)?|change(?:\s+to)?|use|rewrite(?:\s+as)?)\s*[:\-–—]?\s*/i, "")
    .trim();
}

export interface PlannedEdit {
  id: string;
  label: string;
  edit: TextEdit;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * Every edit that is safe to apply in one go: unresolved, placed, confidently
 * matched, precisely located, and needing no text from the author. Strikeouts
 * are deleted; highlights, underlines and replacements with a suggestion in the
 * note are replaced; insert marks get the suggested text.
 */
export function planAllConfident(
  source: string,
  items: ReviewItem[],
  isConfident: (item: ReviewItem) => boolean
): PlannedEdit[] {
  const out: PlannedEdit[] = [];
  for (const item of items) {
    if (item.resolved || !itemSpan(item) || !isConfident(item)) continue;
    if (item.kind === "strikeout") {
      const r = markedRange(source, item);
      if (!r) continue;
      out.push({
        id: item.id,
        label: `Delete “${clip(source.slice(r.from, r.to), 50)}”`,
        edit: { from: r.from, to: r.to, insert: "" },
      });
    } else if (
      item.kind === "replace" ||
      ((item.kind === "highlight" || item.kind === "underline") && item.comment)
    ) {
      const r = markedRange(source, item);
      const value = parseSuggestion(item.comment);
      if (!r || !value) continue;
      out.push({
        id: item.id,
        label: `Replace “${clip(source.slice(r.from, r.to), 32)}” → “${clip(value, 32)}”`,
        edit: { from: r.from, to: r.to, insert: value },
      });
    } else if (item.kind === "insert") {
      const at = insertOffset(source, item);
      const value = parseSuggestion(item.comment);
      if (at == null || !value) continue;
      out.push({
        id: item.id,
        label: `Insert “${clip(value, 50)}”`,
        edit: { from: at, to: at, insert: ` ${value}` },
      });
    }
  }
  return out;
}

/** True when any two edits touch the same characters (applying both would corrupt). */
export function overlaps(edits: TextEdit[]): boolean {
  const s = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < s.length; i++) {
    if (s[i].from < s[i - 1].to) return true;
    if (s[i].from === s[i - 1].from && s[i].to === s[i - 1].to) return true;
  }
  return false;
}
