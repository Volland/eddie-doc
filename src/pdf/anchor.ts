/**
 * Decide where each review item belongs in a freshly rendered PDF.
 *
 * The stored `annotation.geometry` describes the PDF the editor marked up. That
 * file no longer exists: the author has edited the source and rebuilt, so every
 * page number and rectangle in it is meaningless. This module therefore ignores
 * the stored geometry completely and re-derives position from text.
 *
 * The query is the *current* source, never the editor's original wording.
 * Measured on a real 31-page chapter, searching the fresh PDF for the editor's
 * marked text found only 9 of 45 annotations — her phrasing had been rewritten
 * away — while searching for the current source text at the same location found
 * 40 of the 41 items that have one. The editor's words say what she read; the
 * source says what the reader will read now, and only the latter is on the page.
 */
import { locate } from "../matching/align.js";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewItem } from "../model/types.js";
import { buildPdfIndex, locateInPdf, type PdfHit, type PdfIndex } from "./locate.js";
import type { PageText } from "./extract.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** How tightly a mark could be placed. */
export type Precision =
  /** Landed on exactly the words the editor marked. */
  | "exact"
  /** Landed on the paragraph, because the marked words no longer exist. */
  | "line"
  /** Landed via the enclosing block's named destination (figures, tables). */
  | "block";

/** An item resolved onto the fresh PDF. */
export interface AnchoredItem {
  item: ReviewItem;
  hit: PdfHit;
  precision: Precision;
}

/** An item that could not be placed, and why. */
export interface UnstampedItem {
  item: ReviewItem;
  reason: string;
}

export interface AnchorResult {
  anchored: AnchoredItem[];
  unstamped: UnstampedItem[];
}

export interface AnchorOptions {
  /** Below this, a hit is treated as too weak to stamp. Default 0.9. */
  minScore?: number;
  /**
   * Named destinations from the fresh PDF (`doc.getDestinations()`), used to
   * place marks on figures and tables — they render as images with no text to
   * search for, but the author already gives every one an id.
   */
  destinations?: Map<string, { page: number; y: number }>;
}

/**
 * Text of the source lines an item covers. Uses the match's full span so a
 * highlight over a paragraph queries the paragraph, not just its first line.
 */
function sourceSpanText(item: ReviewItem, lines: string[]): string {
  const start = effectiveLine(item);
  if (start === UNMATCHED || start >= lines.length) return "";
  const end =
    item.manualLine != null
      ? start
      : Math.min(item.match?.endLine ?? start, lines.length - 1);
  return lines.slice(start, Math.max(start, end) + 1).join(" ");
}

/**
 * Place every item of `items` onto the PDF described by `pages`.
 *
 * `source` is the current text of the document the items belong to — the same
 * text the PDF was rendered from.
 */
export function anchorItems(
  items: ReviewItem[],
  source: string,
  pages: PageText[],
  opts: AnchorOptions = {}
): AnchorResult {
  const idx = buildPdfIndex(pages);
  const lines = source.split(/\r?\n/);
  const minScore = opts.minScore ?? 0.9;

  const anchored: AnchoredItem[] = [];
  const unstamped: UnstampedItem[] = [];

  for (const item of items) {
    const placed = anchorOne(item, lines, idx, opts, minScore);
    if ("reason" in placed) unstamped.push({ item, reason: placed.reason });
    else anchored.push(placed);
  }

  // Document order, so the stamped file reads the way the source does.
  anchored.sort(
    (a, b) => a.hit.page - b.hit.page || b.hit.rect[3] - a.hit.rect[3]
  );
  return { anchored, unstamped };
}

function anchorOne(
  item: ReviewItem,
  lines: string[],
  idx: PdfIndex,
  opts: AnchorOptions,
  minScore: number
): AnchoredItem | { reason: string } {
  // 1. Figures and tables: no text layer, but a named destination.
  const blockId = item.anchor?.blockId;
  if (blockId && opts.destinations?.has(blockId)) {
    const d = opts.destinations.get(blockId)!;
    return { item, hit: destinationHit(d), precision: "block" };
  }

  const span = sourceSpanText(item, lines);
  if (!span.trim()) {
    return {
      reason:
        effectiveLine(item) === UNMATCHED
          ? "no source location — triage it in the editor first"
          : "the source lines it points at are empty",
    };
  }

  // 2. The paragraph as it reads now.
  const hits = locateInPdf(span, idx, { minScore });
  const best = hits[0];
  if (!best) {
    return { reason: "current source text not found in the rendered PDF" };
  }
  if (best.score < minScore) {
    return {
      reason: `weak match (${best.score.toFixed(2)}) — the anchor looks stale`,
    };
  }

  // 3. Narrow to the editor's marked words when they survived the rewrite. A
  //    strikeout should sit on the struck phrase, not the whole paragraph —
  //    but if the author rewrote those words, degrade to the paragraph rather
  //    than stamping something that is no longer what she objected to.
  const marked = item.markedText?.trim();
  if (marked && looksNarrowable(item)) {
    const within = locate(marked, span, 0.9);
    if (within) {
      const tight = locateInPdf(marked, idx, { minScore, page: best.page });
      if (tight[0] && tight[0].score >= minScore) {
        return { item, hit: tight[0], precision: "exact" };
      }
    }
  }
  return { item, hit: best, precision: "line" };
}

/**
 * Kinds whose meaning depends on covering specific words. A sticky note is
 * about a place, so widening it to the paragraph loses nothing; a strikeout
 * widened to the paragraph would claim the editor wanted all of it deleted.
 */
function looksNarrowable(item: ReviewItem): boolean {
  return (
    item.kind === "strikeout" ||
    item.kind === "highlight" ||
    item.kind === "underline" ||
    item.kind === "replace"
  );
}

/**
 * A destination is a point, not a span. Give it a line-height band across the
 * text column so the mark is visible and clickable rather than zero-sized.
 */
function destinationHit(d: { page: number; y: number }): PdfHit {
  const x0 = 48;
  const x1 = 564;
  const y0 = d.y - 12;
  const y1 = d.y;
  return {
    page: d.page,
    rect: [x0, y0, x1, y1],
    quadPoints: [x0, y1, x1, y1, x0, y0, x1, y0],
    score: 1,
  };
}
