import type { Match } from "../model/types.js";
import { tokenizeSourceLine } from "./normalize.js";

interface SourceLine {
  index: number; // 0-based line number
  tokens: string[];
}

export interface SourceIndex {
  lines: SourceLine[];
  raw: string[];
}

export function buildSourceIndex(source: string): SourceIndex {
  const raw = source.split(/\r?\n/);
  const lines = raw.map((line, index) => ({
    index,
    tokens: tokenizeSourceLine(line),
  }));
  return { lines, raw };
}

/** Sørensen–Dice over token bigrams — order-aware, robust to small edits. */
function bigrams(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  if (tokens.length === 1) {
    m.set(tokens[0], 1);
    return m;
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const g = tokens[i] + "" + tokens[i + 1];
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function diceFromBigrams(
  a: Map<string, number>,
  b: Map<string, number>
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  let aTotal = 0;
  let bTotal = 0;
  for (const v of a.values()) aTotal += v;
  for (const [k, v] of b) {
    bTotal += v;
    const av = a.get(k);
    if (av) inter += Math.min(av, v);
  }
  return (2 * inter) / (aTotal + bTotal);
}

/** Multiset token overlap — catches short phrases where bigrams are sparse. */
function jaccardTokens(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function similarity(query: string[], window: string[]): number {
  const dice = diceFromBigrams(bigrams(query), bigrams(window));
  const jac = jaccardTokens(query, window);
  // Blend: bigram similarity dominates, token overlap rescues short phrases.
  return 0.7 * dice + 0.3 * jac;
}

/**
 * Find the best contiguous run of source lines whose prose matches `anchor`.
 * Returns null when the anchor has no usable tokens.
 */
export function matchAnchor(
  anchor: string,
  idx: SourceIndex,
  maxSpanLines = 6
): Match | null {
  const query = tokenizeSourceLine(anchor).length
    ? tokenizeSourceLine(anchor)
    : anchor
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
  if (query.length === 0) return null;

  // Candidate start lines: those with any prose tokens.
  let best: Match | null = null;
  const lines = idx.lines;

  for (let s = 0; s < lines.length; s++) {
    if (lines[s].tokens.length === 0) continue;
    let windowTokens: string[] = [];
    for (let e = s; e < Math.min(lines.length, s + maxSpanLines); e++) {
      if (lines[e].tokens.length === 0 && e !== s) {
        // allow blank/structural lines inside a span but stop growing on 2+.
        continue;
      }
      windowTokens = windowTokens.concat(lines[e].tokens);
      // Don't let the window dwarf the query — cap growth once we're well past.
      if (windowTokens.length > query.length * 3 && e > s) break;
      const score = similarity(query, windowTokens);
      if (!best || score > best.score) {
        best = {
          startLine: s,
          endLine: e,
          score,
          sourceExcerpt: idx.raw
            .slice(s, e + 1)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200),
        };
      }
    }
  }
  return best;
}
