/**
 * Find a phrase in a rendered PDF's text layer, and report where it sits.
 *
 * This is the mirror of `matching/fuzzyMatch.ts`. That module searches the
 * AsciiDoc source for text recovered from an editor's PDF — a hard problem,
 * because the source has usually been rewritten since the editor marked it up.
 * This module searches in the other direction: given a line of the *current*
 * source, find it in a PDF that was rendered from that same source minutes ago.
 * Barring a bug, the text is there verbatim, so hits should score ~1.0 and a
 * weak hit is a signal that something is wrong rather than a match to accept.
 *
 * Positions are derived, never stored: repagination, a font change or a theme
 * tweak move every coordinate in the file, but the words stay findable.
 *
 * Implementation follows `matching/align.ts`: build a monotonic normalization
 * of the page's text alongside a map from each normalized character back to the
 * run and offset it came from, locate the needle in normalized space, then
 * translate the hit back into page geometry.
 */
import { normalizeText } from "../matching/normalize.js";
import type { Box, PageText, PositionedText } from "./extract.js";

/** Where a phrase was found in the PDF. */
export interface PdfHit {
  /** 1-based page number. */
  page: number;
  /** Bounding box of the whole match, `[x0, y0, x1, y1]` in PDF points. */
  rect: [number, number, number, number];
  /** Per-line quads, 8 numbers each, in PDF `/QuadPoints` order. */
  quadPoints: number[];
  /** 0–1 confidence. 1 means an exact normalized-substring hit. */
  score: number;
}

/** A page prepared for searching. */
interface PageIndex {
  page: number;
  runs: PositionedText[];
  /** Lowercased alnum text with all other characters collapsed to one space. */
  norm: string;
  /** For normalized char i: which run it came from. */
  runOf: number[];
  /** For normalized char i: its character offset within that run. */
  offOf: number[];
}

export interface PdfIndex {
  pages: PageIndex[];
}

/** True for characters {@link normalizeText} keeps (letters and digits). */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Reading order: top-to-bottom, then left-to-right within a line band. */
function readingOrder(a: PositionedText, b: PositionedText): number {
  const dy = b.box.y1 - a.box.y1;
  if (Math.abs(dy) > 4) return dy;
  return a.box.x0 - b.box.x0;
}

/**
 * Build the searchable index. Runs are joined the way a reader would read them:
 * consecutive lines separated by a space, except where the previous line ends
 * in a soft hyphen, whose word continues on the next line and must be rejoined
 * (rare — 12 of 2176 runs in a real chapter — but it would otherwise break the
 * one word a reviewer is most likely to have marked).
 */
export function buildPdfIndex(pages: PageText[]): PdfIndex {
  return {
    pages: pages.map((p) => {
      const runs = [...p.texts].sort(readingOrder);
      const norm: string[] = [];
      const runOf: number[] = [];
      const offOf: number[] = [];
      let lastWasSpace = true; // trims leading whitespace

      for (let r = 0; r < runs.length; r++) {
        const s = runs[r].str;
        // A trailing hyphen is a line-break hyphen: drop it and join with no
        // separator so "life-\ncycle" normalizes to "lifecycle".
        const hyphenated = /[\p{L}]-$/u.test(s);
        const end = hyphenated ? s.length - 1 : s.length;

        for (let i = 0; i < end; i++) {
          const ch = s[i];
          if (isWordChar(ch)) {
            norm.push(ch.toLowerCase());
            runOf.push(r);
            offOf.push(i);
            lastWasSpace = false;
          } else if (!lastWasSpace) {
            norm.push(" ");
            runOf.push(r);
            offOf.push(i);
            lastWasSpace = true;
          }
        }
        // Separate this run from the next unless a word straddles them.
        if (!hyphenated && !lastWasSpace) {
          norm.push(" ");
          runOf.push(r);
          offOf.push(Math.max(0, end - 1));
          lastWasSpace = true;
        }
      }
      // Drop a trailing separator so it can never be part of a match.
      while (norm.length && norm[norm.length - 1] === " ") {
        norm.pop();
        runOf.pop();
        offOf.pop();
      }
      return { page: p.page, runs, norm: norm.join(""), runOf, offOf };
    }),
  };
}

export interface LocateOptions {
  /** Reject hits below this. Default 0.9 — see the module note on scoring. */
  minScore?: number;
  /** Most candidates to return, best first. Default 5. */
  limit?: number;
  /** Only search this 1-based page. */
  page?: number;
  /** Probe length. See {@link DEFAULT_PROBE_CHARS}. */
  probeChars?: number;
}

/**
 * How much of a long phrase to search for as one unit.
 *
 * The index is per page, so a query longer than the text remaining on a page
 * can never match it — and a paragraph that straddles a page break would find
 * nothing at all. Measured on a real 31-page chapter: querying whole matched
 * spans (some 3800 characters) located 19 of 45 annotations; probing with a
 * bounded prefix and then extending located 40 of the 41 that have a location.
 *
 * A probe is a prefix only. Once it anchors, {@link commonPrefixLen} walks the
 * match forward for as long as the page keeps agreeing with the phrase, so a
 * passage that does fit on one page still gets quads over its whole length and
 * one that does not stops cleanly at the page edge.
 */
const DEFAULT_PROBE_CHARS = 120;

/** Longest prefix of `target` that `hay` matches starting at `at`. */
function commonPrefixLen(hay: string, at: number, target: string): number {
  let k = 0;
  while (k < target.length && at + k < hay.length && hay[at + k] === target[k]) {
    k++;
  }
  return k;
}

/** First `n` characters of `s`, cut back to a word boundary when possible. */
function probeOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return sp > n / 2 ? cut.slice(0, sp) : cut;
}

/**
 * Find `phrase` in the indexed PDF, best match first.
 *
 * Exact normalized substring hits are collected first and returned as score 1.
 * Only when no page yields one does it fall back to a sliding character-
 * similarity window, which costs more and is far likelier to be wrong.
 */
export function locateInPdf(
  phrase: string,
  idx: PdfIndex,
  opts: LocateOptions = {}
): PdfHit[] {
  const minScore = opts.minScore ?? 0.9;
  const limit = opts.limit ?? 5;
  const target = normalizeText(phrase);
  if (!target) return [];
  const probe = probeOf(target, opts.probeChars ?? DEFAULT_PROBE_CHARS);

  const pages = opts.page
    ? idx.pages.filter((p) => p.page === opts.page)
    : idx.pages;

  const hits: PdfHit[] = [];
  for (const p of pages) {
    if (!p.norm) continue;
    let from = 0;
    for (;;) {
      const at = p.norm.indexOf(probe, from);
      if (at < 0) break;
      // Extend past the probe for as far as this page keeps agreeing, so a
      // passage longer than the probe is covered in full when it fits.
      const len = Math.max(probe.length, commonPrefixLen(p.norm, at, target));
      const hit = toHit(p, at, at + len - 1, 1);
      if (hit) hits.push(hit);
      from = at + 1;
      if (hits.length >= limit * 4) break; // plenty to rank; stop scanning
    }
  }
  if (hits.length) {
    // Prefer the candidate that matched the most of the phrase; ties keep
    // document order, which is what a monotonic caller expects.
    hits.sort((a, b) => quadSpan(b) - quadSpan(a));
    return hits.slice(0, limit);
  }

  // Nothing exact. The phrase may have been rendered with a ligature, a
  // discretionary hyphen or a glyph pdfjs decodes differently — try the
  // best-scoring window on each page and let the caller judge the score.
  for (const p of pages) {
    const best = bestWindow(p, probe, minScore);
    if (best) hits.push(best);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Total quad width, as a proxy for how much of the phrase a hit covers. */
function quadSpan(h: PdfHit): number {
  let w = 0;
  for (let i = 0; i + 7 < h.quadPoints.length; i += 8) {
    w += Math.abs(h.quadPoints[i + 2] - h.quadPoints[i]);
  }
  return w;
}

/** Best sliding-window match on one page, or null if nothing clears `min`. */
function bestWindow(p: PageIndex, target: string, min: number): PdfHit | null {
  const L = target.length;
  if (p.norm.length < L) return null;
  let bestAt = -1;
  let bestScore = 0;
  // Step by one character; pages are a few thousand characters, so this is
  // cheap next to parsing the PDF in the first place.
  for (let i = 0; i + L <= p.norm.length; i++) {
    let same = 0;
    for (let k = 0; k < L; k++) if (p.norm[i + k] === target[k]) same++;
    const s = same / L;
    if (s > bestScore) {
      bestScore = s;
      bestAt = i;
      if (s === 1) break;
    }
  }
  if (bestAt < 0 || bestScore < min) return null;
  return toHit(p, bestAt, bestAt + L - 1, bestScore);
}

/**
 * Translate a normalized character range back into page geometry.
 *
 * Each source run is a whole rendered line, so a match that spans several runs
 * becomes several quads — one per line — which is exactly what a PDF markup
 * annotation wants in `/QuadPoints`. Within a run, character positions are
 * estimated by dividing its advance width evenly. That is only an approximation
 * for a proportional font, but the same approximation the extractor already
 * relies on, and it is applied to whole words at both ends of the span, where a
 * fraction of a character does not matter.
 */
function toHit(
  p: PageIndex,
  startNorm: number,
  endNorm: number,
  score: number
): PdfHit | null {
  if (startNorm > endNorm) return null;

  /** run index → first/last character offset touched within that run. */
  const spans = new Map<number, { lo: number; hi: number }>();
  for (let i = startNorm; i <= endNorm; i++) {
    const r = p.runOf[i];
    const o = p.offOf[i];
    if (r === undefined) continue;
    const cur = spans.get(r);
    if (!cur) spans.set(r, { lo: o, hi: o });
    else {
      if (o < cur.lo) cur.lo = o;
      if (o > cur.hi) cur.hi = o;
    }
  }
  if (!spans.size) return null;

  const quadPoints: number[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const [r, span] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
    const run = p.runs[r];
    const box = run.box;
    const n = run.str.length || 1;
    const cw = (box.x1 - box.x0) / n;
    const qx0 = box.x0 + span.lo * cw;
    const qx1 = box.x0 + (span.hi + 1) * cw;
    const q = clampBox({ x0: qx0, y0: box.y0, x1: qx1, y1: box.y1 }, box);
    // PDF /QuadPoints order: upper-left, upper-right, lower-left, lower-right.
    quadPoints.push(q.x0, q.y1, q.x1, q.y1, q.x0, q.y0, q.x1, q.y0);
    x0 = Math.min(x0, q.x0);
    y0 = Math.min(y0, q.y0);
    x1 = Math.max(x1, q.x1);
    y1 = Math.max(y1, q.y1);
  }

  return { page: p.page, rect: [x0, y0, x1, y1], quadPoints, score };
}

/** Keep an estimated span inside its run's real box. */
function clampBox(q: Box, within: Box): Box {
  return {
    x0: Math.max(within.x0, Math.min(q.x0, within.x1)),
    x1: Math.max(within.x0, Math.min(q.x1, within.x1)),
    y0: within.y0,
    y1: within.y1,
  };
}
