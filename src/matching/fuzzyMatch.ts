import type { Match } from "../model/types.js";
import {
  tokenizeSourceLine,
  normalizeText,
  commentLineFlags,
} from "./normalize.js";

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
  /** Occurrences of each prose token across the document (comments excluded). */
  freq: Map<string, number>;
}

export function buildSourceIndex(source: string): SourceIndex {
  const raw = source.split(/\r?\n/);
  // Comment text never reaches the rendered PDF: drop `//` lines and the whole
  // body of `////` blocks so they can never become match targets.
  const comment = commentLineFlags(raw);
  const lines = raw.map((line, index) => ({
    index,
    tokens: comment[index] ? [] : tokenizeSourceLine(line),
  }));
  const flat: FlatToken[] = [];
  const freq = new Map<string, number>();
  for (const l of lines) {
    for (const t of l.tokens) {
      flat.push({ t, line: l.index });
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return { lines, raw, flat, freq };
}

/** Multiset token counts. */
function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/** Tokenize an annotation anchor, tolerating anchors that are pure markup. */
function queryTokens(anchor: string, idx: SourceIndex): string[] {
  const primary = tokenizeSourceLine(anchor);
  let tokens = primary;
  if (!tokens.length) {
    // Anchor was a structural/markup-only line for tokenizeSourceLine's taste
    // (e.g. it looked like a heading). Fall back to a raw normalize so we still
    // get its words instead of dropping the annotation entirely.
    const n = normalizeText(anchor);
    tokens = n ? n.split(" ") : [];
  }
  return repairSplitTokens(tokens, idx.freq);
}

/**
 * Repair PDF word-split artifacts against the source vocabulary. Extraction
 * breaks words at line wraps and hyphenation points ("knowl- edge" arrives as
 * "knowl", "edge"). Merge two adjacent anchor tokens when their concatenation
 * is a known source token and at least one fragment is not — the source acts
 * as the dictionary, so legitimate word pairs ("data model") survive because
 * both halves are known words.
 */
function repairSplitTokens(
  tokens: string[],
  freq: Map<string, number>
): string[] {
  if (tokens.length < 2) return tokens;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (b !== undefined) {
      const joined = a + b;
      if (freq.has(joined) && (!freq.has(a) || !freq.has(b))) {
        out.push(joined);
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Rarity weight for a token: sharing a distinctive word with a span means far
 * more than sharing "the". Weights decay logarithmically with document
 * frequency. Tokens absent from the source keep full weight — they can never
 * be matched, and their share of the denominator is what penalises paraphrased
 * anchors.
 */
function tokenWeight(freq: Map<string, number>, t: string): number {
  const f = freq.get(t);
  return f ? 1 / (1 + Math.log(f)) : 1;
}

export interface MatchOptions {
  /** Hard cap on how many source lines a single match may span. */
  maxSpanLines: number;
}

const DEFAULTS: MatchOptions = { maxSpanLines: 8 };

/** Float-tolerant "perfect score" — weight sums may differ by an ulp. */
const PERFECT = 1 - 1e-9;

/**
 * Slide anchored, size-varying windows over the flat token stream, reporting
 * every candidate span to `onSpan` (return true from it to stop the scan).
 *
 * Rather than scoring whole-line windows (which can't isolate a sentence that
 * starts mid-line or wraps across lines), we search contiguous windows of the
 * flat token stream, scored by a rarity-weighted token-multiset Dice against
 * the query. Searching the window *size* — not just its start — lets a short
 * highlight match a tight span while a wrapped paragraph grows to cover its
 * words; the multiset (bag-of-words) metric shrugs off the token boundary
 * noise PDF extraction introduces; and the rarity weighting stops stopword
 * pile-ups from outscoring the distinctive words that actually locate a
 * phrase.
 */
function scanWindows(
  query: string[],
  idx: SourceIndex,
  maxSpanLines: number,
  onSpan: (startLine: number, endLine: number, score: number) => boolean
): void {
  const flat = idx.flat;
  const need = counts(query);
  const weights = new Map<string, number>();
  let wQuery = 0;
  for (const t of query) {
    let w = weights.get(t);
    if (w === undefined) {
      w = tokenWeight(idx.freq, t);
      weights.set(t, w);
    }
    wQuery += w;
  }
  // Windows never need to be much larger than the query: allow generous slack
  // for wrapping/interleaved stripped markup, then let Dice punish bloat.
  const maxWin = Math.min(flat.length, query.length * 2 + 8);

  for (let i = 0; i < flat.length; i++) {
    // Only anchor windows at a token the query actually contains — huge pruning
    // on long documents with no effect on the result.
    if (!need.has(flat[i].t)) continue;

    const have = new Map<string, number>();
    let wOverlap = 0;
    let wWindow = 0;
    const end = Math.min(flat.length, i + maxWin);
    const startLine = flat[i].line;

    for (let e = i; e < end; e++) {
      const endLine = flat[e].line;
      if (endLine - startLine >= maxSpanLines) break;

      const x = flat[e].t;
      let wx = weights.get(x);
      if (wx === undefined) {
        wx = tokenWeight(idx.freq, x);
        weights.set(x, wx);
      }
      wWindow += wx;
      const h = (have.get(x) || 0) + 1;
      have.set(x, h);
      if (h <= (need.get(x) || 0)) wOverlap += wx;

      const score = (2 * wOverlap) / (wQuery + wWindow);
      if (onSpan(startLine, endLine, score)) return;
    }
  }
}

/**
 * Find the best span of source tokens that matches `anchor` (see
 * {@link scanWindows} for how spans are generated and scored).
 *
 * Returns null when the anchor has no usable tokens or the source is empty.
 */
export function matchAnchor(
  anchor: string,
  idx: SourceIndex,
  opts: Partial<MatchOptions> = {}
): Match | null {
  const { maxSpanLines } = { ...DEFAULTS, ...opts };
  const query = queryTokens(anchor, idx);
  if (query.length === 0 || idx.flat.length === 0) return null;

  let best: { startLine: number; endLine: number; score: number } | null = null;
  scanWindows(query, idx, maxSpanLines, (startLine, endLine, score) => {
    if (!best || score > best.score) best = { startLine, endLine, score };
    return score >= PERFECT; // can't beat a perfect hit
  });

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
  const query = queryTokens(anchor, idx);
  if (query.length === 0 || idx.flat.length === 0 || k <= 0) return [];

  // Best (highest-scoring) span found starting at each distinct source line.
  const bestByStart = new Map<number, { endLine: number; score: number }>();
  scanWindows(query, idx, maxSpanLines, (startLine, endLine, score) => {
    const prev = bestByStart.get(startLine);
    if (!prev || score > prev.score) {
      bestByStart.set(startLine, { endLine, score });
    }
    return false;
  });

  const cands: Candidate[] = [];
  for (const [startLine, v] of bestByStart) {
    cands.push({ startLine, endLine: v.endLine, score: v.score });
  }
  // Highest score first; break ties by earliest line for a stable order.
  cands.sort((a, b) => b.score - a.score || a.startLine - b.startLine);
  return cands.slice(0, k);
}
