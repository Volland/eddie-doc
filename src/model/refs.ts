/**
 * The editor's own reference number for a mark.
 *
 * Copyeditors number their queries — `[12]`, `[C7]`, `[AU 3]` — and then talk
 * about them by number: in a covering email, in a style sheet, on the phone.
 * That number is how a remark is *addressed*, so it has to be the first thing
 * visible about it. In the PDF it can sit anywhere in the comment, and every
 * label in this extension is length-capped, so a trailing `[12]` was reliably
 * the first casualty of truncation.
 *
 * These helpers lift the reference out of the comment for display and hand back
 * the remaining prose. Nothing here mutates the sidecar: the comment is what the
 * editor wrote, and it is stored exactly as it arrived (`docs/FORMAT.md`).
 */
import type { ReviewItem } from "./types.js";

/**
 * A bracketed reference: mostly digits, with room for the short prefixes and
 * suffixes editors actually use (`[C12]`, `[AU 3]`, `[12a]`, `[12–14]`).
 *
 * Deliberately narrow. A comment may well quote AsciiDoc — `[#anchor]`,
 * `[source,ruby]`, `[quote]` — and promoting one of those to a heading would be
 * worse than showing nothing, so a match must contain a digit and stay short.
 */
const REF = /\[\s*([A-Za-z#]{0,3}\s?\d{1,4}(?:\s?[-–—]\s?\d{1,4})?[a-z]?)\s*\]/;

/** The editor's reference for this comment, normalised as `[12]`, or undefined. */
export function commentRef(comment: string | undefined): string | undefined {
  const m = REF.exec(comment ?? "");
  return m ? `[${m[1].replace(/\s+/g, "")}]` : undefined;
}

/** The comment with its reference removed, for showing beside a hoisted ref. */
export function withoutRef(comment: string | undefined): string {
  const text = comment ?? "";
  if (!commentRef(text)) return text;
  return (
    text
      .replace(REF, " ")
      // Editors write "[12]: check this" and "[12] - check this"; with the
      // reference hoisted, the orphaned punctuation reads as a typo.
      .replace(/^[\s:;.\-–—]+/, "")
      .replace(/\s+/g, " ")
      .trim() || text.trim()
  );
}

/** This item's reference, as a display prefix: `"[12] "`, or `""`. */
export function refPrefix(item: ReviewItem): string {
  const ref = commentRef(item.comment);
  return ref ? `${ref} ` : "";
}
