import type { Match } from "../model/types.js";
import { tokenizeSourceLine, normalizeText } from "./normalize.js";

interface SourceLine {
  index: number; // 0-based line number
  tokens: string[];
}

/** One source token flattened out of its line, keeping a back-reference. */
interface FlatToken {
  t: string;
  line: number; // 0-based source line this token came from
}

export interface SourceIndex {
  lines: SourceLine[];
  raw: string[];
  /** Every prose token in document order, each tagged with its source line. */
  flat: FlatToken[];
}

export function buildSourceIndex(source: string): SourceIndex {
  const raw = source.split(/\r?\n/);
  const lines = raw.map((line, index) => ({
    index,
    tokens: tokenizeSourceLine(line),
  }));
  const flat: FlatToken[] = [];
  for (const l of lines) {
    for (const t of l.tokens) flat.push({ t, line: l.index });
  }
  return { lines, raw, flat };
}

/** Multiset token counts. */
function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/** Tokenize an annotation anchor, tolerating anchors that are pure markup. */
function queryTokens(anchor: string): string[] {
  const primary = tokenizeSourceLine(anchor);
  if (primary.length) return primary;
  // Anchor was a structural/markup-only line for tokenizeSourceLine's taste
  // (e.g. it looked like a heading). Fall back to a raw normalize so we still
  // get its words instead of dropping the annotation entirely.
  const n = normalizeText(anchor);
  return n ? n.split(" ") : [];
}

export interface MatchOptions {
  /** Hard cap on how many source lines a single match may span. */
  maxSpanLines: number;
}

const DEFAULTS: MatchOptions = { maxSpanLines: 8 };

/**
 * Find the best span of source tokens that matches `anchor`.
 *
 * Rather than scoring whole-line windows (which can't isolate a sentence that
 * starts mid-line or wraps across lines), we search contiguous windows of the
 * flat token stream and keep the one with the highest token-multiset Dice
 * against the query. Searching the window *size* — not just its start — lets a
 * short highlight match a tight span while a wrapped paragraph grows to cover
 * its words, and the multiset (bag-of-words) metric shrugs off the token
 * boundary noise that PDF extraction introduces.
 *
 * Returns null when the anchor has no usable tokens or the source is empty.
 */
export function matchAnchor(
  anchor: string,
  idx: SourceIndex,
  opts: Partial<MatchOptions> = {}
): Match | null {
  const { maxSpanLines } = { ...DEFAULTS, ...opts };
  const query = queryTokens(anchor);
  const flat = idx.flat;
  if (query.length === 0 || flat.length === 0) return null;

  const need = counts(query);
  const m = query.length;
  // Windows never need to be much larger than the query: allow generous slack
  // for wrapping/interleaved stripped markup, then let Dice punish bloat.
  const maxWin = Math.min(flat.length, m * 2 + 8);

  let best: { startLine: number; endLine: number; score: number } | null = null;

  for (let i = 0; i < flat.length; i++) {
    // Only anchor windows at a token the query actually contains — huge pruning
    // on long documents with no effect on the result.
    if (!need.has(flat[i].t)) continue;

    const have = new Map<string, number>();
    let overlap = 0;
    const end = Math.min(flat.length, i + maxWin);
    const startLine = flat[i].line;

    for (let e = i; e < end; e++) {
      const endLine = flat[e].line;
      if (endLine - startLine >= maxSpanLines) break;

      const x = flat[e].t;
      const h = (have.get(x) || 0) + 1;
      have.set(x, h);
      if (h <= (need.get(x) || 0)) overlap++;

      const winLen = e - i + 1;
      const score = (2 * overlap) / (m + winLen);
      if (!best || score > best.score) {
        best = { startLine, endLine, score };
        if (score === 1) return finalize(best, idx); // can't beat a perfect hit
      }
    }
  }

  if (!best) return null;
  return finalize(best, idx);
}

function finalize(
  best: { startLine: number; endLine: number; score: number },
  idx: SourceIndex
): Match {
  return {
    startLine: best.startLine,
    endLine: best.endLine,
    score: best.score,
    sourceExcerpt: idx.raw
      .slice(best.startLine, best.endLine + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
  };
}

/** A ranked candidate span for an anchor — a match proposal, threshold aside. */
export interface Candidate {
  /** 0-based start line of the best-scoring span anchored here. */
  startLine: number;
  /** 0-based end line (inclusive). */
  endLine: number;
  /** 0-1 similarity of the span. */
  score: number;
}

/**
 * Rank the best candidate source spans for `anchor`, best score first.
 *
 * Unlike {@link matchAnchor} — which returns only the single winner and hides
 * everything below the map threshold — this keeps the best span per distinct
 * start line and returns the top `k`. It's the data behind the Unmatched
 * batch-triage flow: an editor whose highlight the token matcher couldn't place
 * confidently still gets a short, ranked shortlist to choose from in one pass.
 *
 * Returns an empty array when the anchor has no usable tokens or the source is
 * empty.
 */
export function topMatches(
  anchor: string,
  idx: SourceIndex,
  k: number,
  opts: Partial<MatchOptions> = {}
): Candidate[] {
  const { maxSpanLines } = { ...DEFAULTS, ...opts };
  const query = queryTokens(anchor);
  const flat = idx.flat;
  if (query.length === 0 || flat.length === 0 || k <= 0) return [];

  const need = counts(query);
  const m = query.length;
  const maxWin = Math.min(flat.length, m * 2 + 8);

  // Best (highest-scoring) span found starting at each distinct source line.
  const bestByStart = new Map<number, { endLine: number; score: number }>();

  for (let i = 0; i < flat.length; i++) {
    if (!need.has(flat[i].t)) continue;

    const have = new Map<string, number>();
    let overlap = 0;
    const end = Math.min(flat.length, i + maxWin);
    const startLine = flat[i].line;

    for (let e = i; e < end; e++) {
      const endLine = flat[e].line;
      if (endLine - startLine >= maxSpanLines) break;

      const x = flat[e].t;
      const h = (have.get(x) || 0) + 1;
      have.set(x, h);
      if (h <= (need.get(x) || 0)) overlap++;

      const winLen = e - i + 1;
      const score = (2 * overlap) / (m + winLen);
      const prev = bestByStart.get(startLine);
      if (!prev || score > prev.score) {
        bestByStart.set(startLine, { endLine, score });
      }
    }
  }

  const cands: Candidate[] = [];
  for (const [startLine, v] of bestByStart) {
    cands.push({ startLine, endLine: v.endLine, score: v.score });
  }
  // Highest score first; break ties by earliest line for a stable order.
  cands.sort((a, b) => b.score - a.score || a.startLine - b.startLine);
  return cands.slice(0, k);
}
