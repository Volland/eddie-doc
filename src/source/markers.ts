/**
 * Durable source anchors — the mechanism that stops annotations drifting away
 * from the text they belong to.
 *
 * Line numbers are only correct while someone is watching the edits. Live
 * position tracking (see `matching/posTrack.ts`) follows keystrokes inside the
 * editor, but a `sed`, a git merge, or an agent rewriting a file bypasses it
 * entirely, and afterwards the only way back is to match the *editor's* PDF text
 * — which describes the prose as it was before the rewrite — against prose that
 * has since changed. That is the search problem this module exists to avoid.
 *
 * Instead we record identities that travel with the text itself:
 *
 * - a `// eddie:<id>` comment line injected above the anchored block, which
 *   moves with the block no matter who edits it;
 * - the enclosing AsciiDoc block id (`[#ch04-figure-anatomy]`), which the author
 *   already writes for every figure and table;
 * - a fingerprint of the block's normalized text, plus a few words either side.
 *
 * Marker comments are safe in a manuscript: Asciidoctor's preprocessor strips
 * `//` lines before rendering, so they cannot reach the PDF, and
 * `commentLineFlags()` already excludes them from matching so they can never
 * become a match target either.
 *
 * This module is pure — no `vscode`, no filesystem — so the CLI, the extension
 * and the tests all share one implementation.
 */
import { createHash } from "node:crypto";
import type { MatchMethod, SourceAnchor } from "../model/types.js";
import { isStructuralLine, normalizeText } from "../matching/normalize.js";
import { buildBlocks } from "../matching/semantic.js";

/** A marker comment line: `// eddie:a3f21c94`. */
const MARKER_RE = /^\s*\/\/\s*eddie:([0-9a-f]{6,32})\s*$/;

/** Render a marker line for `id`, with no trailing whitespace. */
export function markerLine(id: string): string {
  return `// eddie:${id}`;
}

/** True when `line` is an Eddie Doc marker comment. */
export function isMarkerLine(line: string): boolean {
  return MARKER_RE.test(line);
}

/**
 * A marker found in the source: where the comment itself sits, and the content
 * line it anchors. Consumers almost always want `targetLine`.
 */
export interface MarkerHit {
  id: string;
  /** 0-based line of the `// eddie:…` comment. */
  markerLine: number;
  /** 0-based line of the first real content the marker sits above. */
  targetLine: number;
}

/**
 * Every marker in `source`, keyed by id.
 *
 * A duplicated id (from a copy-paste of a whole block) keeps its *first*
 * occurrence — resolving to a deterministic place matters more than guessing
 * which copy the reviewer meant, and the orphan tray surfaces the oddity.
 */
export function findMarkers(source: string): Map<string, MarkerHit> {
  const lines = source.split(/\r?\n/);
  const out = new Map<string, MarkerHit>();
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i]);
    if (!m) continue;
    const id = m[1];
    if (out.has(id)) continue;
    out.set(id, { id, markerLine: i, targetLine: contentLineAfter(lines, i) });
  }
  return out;
}

/** Source with every marker comment removed. */
export function stripMarkers(source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return source
    .split(/\r?\n/)
    .filter((l) => !isMarkerLine(l))
    .join(eol);
}

/**
 * The first line at or after `from` that carries real content — skipping blank
 * lines, other markers, and the block's attribute/title lines (`[#id]`,
 * `[NOTE]`, `.Caption`). That is the line the reader would call "the block".
 */
function contentLineAfter(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") continue;
    if (isMarkerLine(lines[i])) continue;
    if (isAttachedAttribute(t)) continue;
    return i;
  }
  return Math.min(from + 1, Math.max(0, lines.length - 1));
}

/**
 * Lines that bind to the block *below* them and must never be separated from
 * it: block attribute lists (`[#id, reftext=…]`, `[source,ruby]`, `[NOTE]`) and
 * block titles (`.Figure caption`).
 */
function isAttachedAttribute(trimmed: string): boolean {
  if (/^\[[^\]]*\]$/.test(trimmed)) return true;
  // A block title — `.Caption text` — but not a list item (`. item`) and not an
  // ellipsis-style delimiter (`....`).
  if (/^\.[^.\s]/.test(trimmed)) return true;
  return false;
}

/**
 * Walk up from `line` to the first line of its paragraph, then up again past
 * any attribute or title lines glued to it. Inserting a marker here keeps the
 * `[#id]`/block pairing intact — dropping a comment between an attribute list
 * and its block is exactly the kind of edit that silently changes a render.
 */
export function insertionLineFor(lines: string[], line: number): number {
  let i = Math.max(0, Math.min(line, lines.length - 1));
  // Up to the start of the contiguous prose run.
  while (i > 0) {
    const prev = lines[i - 1];
    if (prev.trim() === "" || isStructuralLine(prev)) break;
    i--;
  }
  // Then up past attributes, titles and any marker already sitting there.
  while (i > 0) {
    const prev = lines[i - 1].trim();
    if (isAttachedAttribute(prev) || isMarkerLine(lines[i - 1])) i--;
    else break;
  }
  return i;
}

/**
 * The id of the AsciiDoc block enclosing `line` — `[#ch04-figure-anatomy]` or
 * `[[legacy-anchor]]` — when the author gave it one.
 *
 * This is how a mark lands on a figure or a table: those render as images with
 * no text layer, so there is nothing to search for, but the author already
 * writes an id on every one of them.
 */
export function enclosingBlockId(
  source: string,
  line: number
): string | undefined {
  const lines = source.split(/\r?\n/);
  const top = insertionLineFor(lines, line);
  // Scan the attribute stack that was skipped over, nearest first.
  for (let i = top; i < lines.length && i <= line; i++) {
    const t = lines[i].trim();
    const attr = /^\[#([A-Za-z0-9_:.-]+)/.exec(t);
    if (attr) return attr[1];
    const legacy = /^\[\[([A-Za-z0-9_:.-]+)\]\]$/.exec(t);
    if (legacy) return legacy[1];
    if (!isAttachedAttribute(t) && t !== "" && !isMarkerLine(lines[i])) break;
  }
  return undefined;
}

/** Truncated digest of a block's normalized prose — stable across reflow. */
export function fingerprintBlock(text: string): string {
  return createHash("sha256")
    .update(normalizeText(text))
    .digest("hex")
    .slice(0, 16);
}

/** First or last `n` normalized words of a block, for context matching. */
function edgeWords(text: string, n: number, fromEnd: boolean): string {
  const w = normalizeText(text).split(" ").filter(Boolean);
  if (!w.length) return "";
  return (fromEnd ? w.slice(-n) : w.slice(0, n)).join(" ");
}

const CONTEXT_WORDS = 8;

/**
 * Describe where `line` sits, in terms that survive editing. `marker` is folded
 * in when the caller has just injected one.
 */
export function describeAnchor(
  source: string,
  line: number,
  marker?: string
): SourceAnchor {
  const blocks = buildBlocks(source);
  const idx = blocks.findIndex((b) => line >= b.startLine && line <= b.endLine);
  const here = idx >= 0 ? blocks[idx] : undefined;
  const anchor: SourceAnchor = {};
  if (marker) anchor.marker = marker;

  const blockId = enclosingBlockId(source, line);
  if (blockId) anchor.blockId = blockId;
  if (here) {
    anchor.blockFingerprint = fingerprintBlock(here.text);
    const before = blocks[idx - 1];
    const after = blocks[idx + 1];
    if (before) anchor.contextBefore = edgeWords(before.text, CONTEXT_WORDS, true);
    if (after) anchor.contextAfter = edgeWords(after.text, CONTEXT_WORDS, false);
  }
  return anchor;
}

/** One item's request to be anchored at a source line. */
export interface MarkerTarget {
  itemId: string;
  /** 0-based line the item currently resolves to. */
  line: number;
}

/** What {@link injectMarkers} did. */
export interface InjectResult {
  /** The rewritten source. Unchanged when every target already had a marker. */
  source: string;
  /** itemId → marker id, for every target that now has one. */
  assigned: Map<string, string>;
  /** Number of marker comments actually inserted. */
  inserted: number;
}

/**
 * Inject marker comments above the blocks `targets` point at.
 *
 * Idempotent by construction: a block that already carries a marker reuses it
 * rather than accumulating a second one, so running this after every review
 * round leaves the manuscript diff empty once it has settled. Several items on
 * the same block share one marker — the marker identifies the *place*, and the
 * sidecar maps items to it.
 *
 * Insertions are applied bottom-up so that each one cannot shift the line
 * numbers of the targets still queued above it.
 */
export function injectMarkers(
  source: string,
  targets: MarkerTarget[]
): InjectResult {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const assigned = new Map<string, string>();
  if (!targets.length) return { source, assigned, inserted: 0 };

  const existing = findMarkers(source);
  const taken = new Set(existing.keys());
  /** Insertion line → marker id already present there. */
  const atLine = new Map<number, string>();
  for (const hit of existing.values()) {
    atLine.set(insertionLineFor(lines, hit.targetLine), hit.id);
  }

  /** Insertion line → the marker id we will write there. */
  const planned = new Map<number, string>();

  for (const t of targets) {
    if (t.line < 0 || t.line >= lines.length) continue;
    const at = insertionLineFor(lines, t.line);
    const already = atLine.get(at) ?? planned.get(at);
    if (already) {
      assigned.set(t.itemId, already);
      continue;
    }
    const id = mintId(t.itemId, taken);
    taken.add(id);
    planned.set(at, id);
    assigned.set(t.itemId, id);
  }

  // Bottom-up: an insertion never disturbs a line number still to be used.
  const out = [...lines];
  for (const at of [...planned.keys()].sort((a, b) => b - a)) {
    out.splice(at, 0, markerLine(planned.get(at)!));
  }
  return { source: out.join(eol), assigned, inserted: planned.size };
}

/**
 * A short, stable id derived from the item id, lengthened on collision so two
 * different items can never end up sharing one marker.
 */
function mintId(itemId: string, taken: Set<string>): string {
  const full = createHash("sha256").update(itemId).digest("hex");
  for (let len = 8; len <= 32; len += 4) {
    const id = full.slice(0, len);
    if (!taken.has(id)) return id;
  }
  return full.slice(0, 32);
}

/** Where an anchor resolved to, and which tier got there. */
export interface AnchorHit {
  /** 0-based first line of the anchored block. */
  line: number;
  /** 0-based last line of the anchored block, inclusive. */
  endLine: number;
  /** The block's text, for the match's display excerpt. */
  excerpt: string;
  method: MatchMethod;
}

/**
 * Resolve a stored anchor against the current source, trying each recorded
 * identity in descending order of trust. Returns null when the text it was
 * bound to is gone — which is a real answer, not a failure: the paragraph was
 * deleted, and the item genuinely has nowhere to live.
 */
export function resolveAnchor(
  source: string,
  anchor: SourceAnchor | undefined
): AnchorHit | null {
  if (!anchor) return null;
  const blocks = buildBlocks(source);
  /** Widen a single line to the span of the block containing it. */
  const span = (line: number, method: MatchMethod): AnchorHit => {
    const b = blocks.find((x) => line >= x.startLine && line <= x.endLine);
    return b
      ? { line: b.startLine, endLine: b.endLine, excerpt: b.text, method }
      : { line, endLine: line, excerpt: "", method };
  };

  if (anchor.marker) {
    const hit = findMarkers(source).get(anchor.marker);
    // A marker above a figure anchors a line buildBlocks skips (an image macro
    // is structural, not prose), so fall back to the bare line rather than
    // discarding the strongest identity we have.
    if (hit) return span(hit.targetLine, "marker");
  }

  if (anchor.blockId) {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const m =
        /^\[#([A-Za-z0-9_:.-]+)/.exec(t) ??
        /^\[\[([A-Za-z0-9_:.-]+)\]\]$/.exec(t);
      if (m && m[1] === anchor.blockId) {
        return span(contentLineAfter(lines, i), "blockId");
      }
    }
  }

  if (anchor.blockFingerprint) {
    for (const b of blocks) {
      if (fingerprintBlock(b.text) === anchor.blockFingerprint) {
        return {
          line: b.startLine,
          endLine: b.endLine,
          excerpt: b.text,
          method: "fingerprint",
        };
      }
    }
  }

  return null;
}
