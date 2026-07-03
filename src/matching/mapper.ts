import type { Match, RawAnnotation, ReviewItem } from "../model/types.js";
import { buildSourceIndex, matchAnchor, type SourceIndex } from "./fuzzyMatch.js";

export interface MapOptions {
  /** Below this score, the match is discarded and the item is 'unmatched'. */
  threshold: number;
}

/**
 * Match a single annotation against a prepared source index, returning the match
 * only when it clears `threshold`. Shared by the bulk mapper and the per-item
 * "re-map" action so both derive locations the same way.
 */
export function matchOne(
  a: RawAnnotation,
  idx: SourceIndex,
  threshold: number
): Match | null {
  // Prefer the anchored text; fall back to the comment for sticky notes.
  const anchorSource = a.anchoredText || a.comment;
  const raw = matchAnchor(anchorSource, idx);
  return raw && raw.score >= threshold ? raw : null;
}

/** Map extracted annotations onto source lines, preserving prior state. */
export function mapAnnotations(
  annotations: RawAnnotation[],
  source: string,
  opts: MapOptions,
  previous?: ReviewItem[]
): ReviewItem[] {
  const idx: SourceIndex = buildSourceIndex(source);
  const prevById = new Map((previous || []).map((p) => [p.id, p]));

  const items = annotations.map((a): ReviewItem => {
    const prior = prevById.get(a.id);
    const match = matchOne(a, idx, opts.threshold);

    return {
      ...a,
      match,
      resolved: prior?.resolved ?? false,
      manualLine: prior?.manualLine,
      note: prior?.note,
    };
  });

  // Sort by source position (unmatched last), then page.
  return items.sort((x, y) => {
    const lx = effectiveLine(x);
    const ly = effectiveLine(y);
    if (lx !== ly) return lx - ly;
    return x.page - y.page;
  });
}

/** The line an item points at: manual override, else fuzzy match, else -1. */
export function effectiveLine(item: ReviewItem): number {
  if (item.manualLine != null) return item.manualLine;
  if (item.match) return item.match.startLine;
  return Number.MAX_SAFE_INTEGER; // unmatched sinks to the bottom
}
