/**
 * The pure shape of a review comment thread: what its header says, what its
 * head post reads, and what its rendered content depends on.
 *
 * `comments.ts` reconciles live threads in place rather than rebuilding them —
 * disposing a thread closes the popup, discarding whatever the author was
 * halfway through typing — so it needs a cheap way to ask "would this thread
 * render any differently now?". That is `threadSignature`. Nothing here touches
 * `vscode`, so it is directly testable.
 */
import { KIND_LABEL, type ReviewItem } from "../model/types.js";

/** Header line for the thread: kind, page, and how the link was established. */
export function threadLabel(item: ReviewItem): string {
  const bits = [KIND_LABEL[item.kind], `p${item.page}`];
  const m = item.match?.method;
  if (item.manualLine != null) bits.push("manual");
  else if (m === "marker" || m === "blockId" || m === "fingerprint")
    bits.push(`anchored · ${m}`);
  else if (item.match) bits.push(item.match.score.toFixed(2));
  const n = item.replies?.length ?? 0;
  if (n) bits.push(`${n} ${n === 1 ? "reply" : "replies"}`);
  return bits.join(" · ");
}

/** Markdown for the editor's mark: the text marked up, then the note on it. */
export function rootMarkdown(item: ReviewItem): string {
  const marked = (item.markedText || item.anchoredText || "")
    .replace(/\s+/g, " ")
    .trim();
  const quote = marked ? `> ${marked.slice(0, 400)}\n\n` : "";
  return quote + (item.comment || `_${KIND_LABEL[item.kind]} with no note._`);
}

/** Byline under the mark. Falls back to the role, since the PDF may name nobody. */
export function markAuthor(item: ReviewItem): string {
  return item.author || "Editor";
}

/**
 * Everything the thread's posts are rendered from, flattened to a string.
 * Equal signatures mean a rebuilt thread would look exactly like the live one,
 * so the live one is left alone — reply box, focus, scroll position and all.
 */
export function threadSignature(item: ReviewItem): string {
  return JSON.stringify([
    rootMarkdown(item),
    markAuthor(item),
    KIND_LABEL[item.kind],
    item.page,
    (item.replies ?? []).map((r) => [r.id, r.author, r.createdAt, r.body]),
  ]);
}
