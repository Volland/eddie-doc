/**
 * Pure scoring for the matching-quality benchmark: compare mapped review items
 * against a hand-verified golden file. Kept free of I/O so tests can drive it
 * directly; `main.ts` owns file loading and process exit codes.
 */
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewItem } from "../model/types.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** One golden expectation, keyed by the editor's words. */
export interface GoldenCase {
  /**
   * Substring identifying the annotation — matched against the comment first,
   * then the anchored text. Must hit exactly one annotation.
   */
  key: string;
  /** 1-based inclusive [start, end] region the mapped span must overlap. */
  lines?: [number, number];
  /** Set instead of `lines` when the matcher is EXPECTED to give up. */
  expectUnmatched?: boolean;
}

export type CaseStatus =
  | "correct"
  | "wrong-line" // mapped, but outside the expected region — the worst outcome
  | "missed" // expected a location, got unmatched
  | "unexpected-match" // expected unmatched, got a location
  | "annotation-missing"; // no extracted annotation matched the key at all

export interface CaseResult {
  key: string;
  status: CaseStatus;
  /** Human-readable "what we got" for the failure/success line. */
  got: string;
  /** Human-readable expectation. */
  expected: string;
}

export interface BenchSummary {
  total: number;
  correct: number;
  failed: number;
  results: CaseResult[];
}

function findItem(items: ReviewItem[], key: string): ReviewItem | undefined {
  return (
    items.find((it) => it.comment && it.comment.includes(key)) ??
    items.find((it) => it.anchoredText && it.anchoredText.includes(key))
  );
}

/** Score `items` (one mapped document) against its golden `cases`. */
export function scoreItems(
  items: ReviewItem[],
  cases: GoldenCase[]
): BenchSummary {
  const results: CaseResult[] = cases.map((c) => {
    if (!c.expectUnmatched && !c.lines) {
      throw new Error(`golden case "${c.key}" needs either lines or expectUnmatched`);
    }
    const expected = c.expectUnmatched
      ? "unmatched"
      : `lines ${c.lines![0]}–${c.lines![1]}`;

    const item = findItem(items, c.key);
    if (!item) {
      return { key: c.key, status: "annotation-missing", got: "no annotation", expected };
    }

    const line = effectiveLine(item);
    if (line === UNMATCHED) {
      return c.expectUnmatched
        ? { key: c.key, status: "correct", got: "unmatched", expected }
        : { key: c.key, status: "missed", got: "unmatched", expected };
    }

    // 1-based span the mapping produced (manual re-links collapse to one line).
    const start = (item.match?.startLine ?? line) + 1;
    const end = (item.match?.endLine ?? line) + 1;
    const score = item.match ? ` (${item.match.method ?? "fuzzy"} ${item.match.score.toFixed(2)})` : "";
    const got =
      start === end ? `line ${start}${score}` : `lines ${start}–${end}${score}`;

    if (c.expectUnmatched) {
      return { key: c.key, status: "unexpected-match", got, expected };
    }
    const [lo, hi] = c.lines!;
    const overlaps = start <= hi && end >= lo;
    return { key: c.key, status: overlaps ? "correct" : "wrong-line", got, expected };
  });

  const correct = results.filter((r) => r.status === "correct").length;
  return {
    total: results.length,
    correct,
    failed: results.length - correct,
    results,
  };
}
