/**
 * What a review list shows, decided without any UI: which bucket an annotation
 * is in, what a filter lets through, how many of each there are.
 *
 * The VS Code tree and the Obsidian panel both present the same four groups —
 * Open, Needs review, Unmatched, Resolved — and must agree on which annotation
 * belongs in which. This is where that is decided.
 */
import { effectiveLine, isConfident } from "../matching/mapper.js";
import { KIND_LABEL, type AnnotationKind, type ReviewItem } from "../model/types.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** The group an annotation sits in. */
export type Bucket = "open" | "review" | "unmatched" | "resolved";

export const BUCKET_LABEL: Record<Bucket, string> = {
  open: "Open",
  review: "Needs review",
  unmatched: "Unmatched",
  resolved: "Resolved",
};

/** Display order of the groups: what needs the author first, done work last. */
export const BUCKET_ORDER: Bucket[] = ["open", "review", "unmatched", "resolved"];

/** True when the annotation has a place in the source. */
export function isLocated(item: ReviewItem): boolean {
  return effectiveLine(item) !== UNMATCHED;
}

// @lat: [[review-pipeline#Classification]]
/**
 * Resolved wins; otherwise no place means unmatched; otherwise a link the matcher
 * is not sure of (or one gone stale) needs the author's eye.
 */
export function bucketOf(item: ReviewItem, highConfidence: number): Bucket {
  if (item.resolved) return "resolved";
  if (!isLocated(item)) return "unmatched";
  return isConfident(item, highConfidence) ? "open" : "review";
}

export interface ListFilter {
  /** Hide resolved annotations (the `showResolved` setting, inverted). */
  hideResolved?: boolean;
  /** Only these groups; empty or absent means all. */
  buckets?: Bucket[];
  kinds?: AnnotationKind[];
  page?: number;
  /** Case-insensitive match against comment, marked text, author and note. */
  text?: string;
}

/** Items that pass `filter`, in their original (reading) order. */
export function applyFilter(
  items: ReviewItem[],
  filter: ListFilter,
  highConfidence: number
): ReviewItem[] {
  const needle = filter.text?.trim().toLowerCase();
  return items.filter((it) => {
    if (filter.hideResolved && it.resolved) return false;
    if (filter.buckets?.length && !filter.buckets.includes(bucketOf(it, highConfidence))) {
      return false;
    }
    if (filter.kinds?.length && !filter.kinds.includes(it.kind)) return false;
    if (filter.page != null && it.page !== filter.page) return false;
    if (needle) {
      const hay = [it.comment, it.markedText, it.anchoredText, it.author, it.note]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export type Counts = Record<Bucket, number> & { total: number };

export function countBuckets(items: ReviewItem[], highConfidence: number): Counts {
  const c: Counts = { open: 0, review: 0, unmatched: 0, resolved: 0, total: items.length };
  for (const it of items) c[bucketOf(it, highConfidence)]++;
  return c;
}

export interface Group {
  bucket: Bucket;
  label: string;
  items: ReviewItem[];
}

/** Non-empty groups in display order. */
export function groupItems(items: ReviewItem[], highConfidence: number): Group[] {
  const by = new Map<Bucket, ReviewItem[]>();
  for (const it of items) {
    const b = bucketOf(it, highConfidence);
    by.set(b, [...(by.get(b) ?? []), it]);
  }
  return BUCKET_ORDER.filter((b) => by.has(b)).map((b) => ({
    bucket: b,
    label: `${BUCKET_LABEL[b]} (${by.get(b)!.length})`,
    items: by.get(b)!,
  }));
}

/** One-line list label: number, kind, and what the Reviewer said or marked. */
export function itemTitle(item: ReviewItem): string {
  const text = (item.comment || item.markedText || item.anchoredText || KIND_LABEL[item.kind])
    .replace(/\s+/g, " ")
    .trim();
  const clipped = text.length > 70 ? text.slice(0, 70) + "…" : text;
  return item.number != null ? `#${item.number} ${clipped}` : clipped;
}

/** The 0-based lines an item covers, or null when it has no place. */
export function itemSpan(item: ReviewItem): { start: number; end: number } | null {
  const start = effectiveLine(item);
  if (start === UNMATCHED) return null;
  const end = item.manualLine != null ? start : item.match?.endLine ?? start;
  return { start, end: Math.max(start, end) };
}
