/**
 * Our own reference number for a mark: `#3 VP` — the third remark in this
 * mapping, made by V. P.
 *
 * Editors do not always number their queries (see `refs.ts` for the ones who
 * do), and once a mapping holds the marks of several PDFs, "the highlight on
 * page 4" no longer says whose. A number the author can quote back, plus the
 * initials of the person who made the mark, does.
 *
 * Numbers are **assigned once and stored**. They are how a remark gets talked
 * about, so they must not shift when a re-map re-sorts the items, when another
 * PDF is appended, or when mappings are merged: new marks only ever take the
 * next free number. Nothing here touches `vscode`.
 */
import type { ReviewItem } from "./types.js";

/** At most this many letters of initials; "Anna Maria de la Cruz" is still short. */
const MAX_INITIALS = 3;

/**
 * Initials of a person's name as a PDF records it, or undefined when there is
 * nothing name-like to take them from.
 *
 * PDF authors arrive in every shape: "Jane Q. Doe", "doe, jane", "jane.doe",
 * "jane.doe@acme.com", "JaneDoe". Emails lose their domain, and dots,
 * underscores, hyphens and camel case all separate words.
 */
export function initialsOf(name: string | undefined): string | undefined {
  let text = (name ?? "").trim();
  if (!text) return undefined;
  text = text.replace(/@.*$/, "");
  // "Doe, Jane" is the surname-first form reference managers write.
  const comma = /^([^,]+),\s*(.+)$/.exec(text);
  if (comma) text = `${comma[2]} ${comma[1]}`;
  const words = text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .split(/[\s._-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => /^\p{L}/u.test(w));
  if (!words.length) return undefined;
  return words
    .slice(0, MAX_INITIALS)
    .map((w) => w[0].toLocaleUpperCase())
    .join("");
}

/**
 * Author names that name a role or a default rather than a person. PDF tools
 * stamp these when nobody set a name, and "E" for "Editor" would pass for
 * someone's initials — so they defer to whoever the mapping says marked it.
 */
const PLACEHOLDER_AUTHORS = new Set([
  "editor",
  "author",
  "reviewer",
  "user",
  "guest",
  "unknown",
  "anonymous",
  "admin",
  "administrator",
]);

/** True when `name` is a tool's placeholder rather than a person's name. */
export function isPlaceholderAuthor(name: string | undefined): boolean {
  return PLACEHOLDER_AUTHORS.has((name ?? "").trim().toLowerCase());
}

/**
 * Reading order of marks: the mapping's primary PDF first, then each added PDF
 * in the order it was added; within one PDF by page, then top to bottom, then
 * left to right. PDF space has its origin bottom-left, so "top" is the larger y.
 */
export function readingOrder(a: ReviewItem, b: ReviewItem): number {
  return (
    (a.pdfId ?? "").localeCompare(b.pdfId ?? "", undefined, { numeric: true }) ||
    a.page - b.page ||
    Math.round(b.rect[3]) - Math.round(a.rect[3]) ||
    a.rect[0] - b.rect[0] ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Give every unnumbered item the next free number, in reading order, and fill
 * in initials where they are missing. Items that already have a number keep it.
 *
 * `fallbackName` names whoever made a mark the PDF does not attribute — the
 * reviewer or origin recorded for the PDF it came from.
 *
 * A number that has been used twice (two mappings merged by an older build, a
 * hand-edited sidecar) is resolved in favour of the first holder in reading
 * order; the other takes a fresh one, so a number always names one remark.
 *
 * Returns true when anything changed.
 */
export function assignNumbers(
  items: ReviewItem[],
  fallbackName: (item: ReviewItem) => string | undefined = () => undefined
): boolean {
  let changed = false;
  const seen = new Set<number>();
  const ordered = items.slice().sort(readingOrder);

  for (const it of ordered) {
    if (it.number == null) continue;
    if (!Number.isInteger(it.number) || it.number < 1 || seen.has(it.number)) {
      it.number = undefined;
      changed = true;
      continue;
    }
    seen.add(it.number);
  }

  let next = seen.size ? Math.max(...seen) + 1 : 1;
  for (const it of ordered) {
    if (it.number == null) {
      it.number = next++;
      changed = true;
    }
    if (!it.initials) {
      const own = isPlaceholderAuthor(it.author) ? undefined : it.author;
      const initials = initialsOf(own) ?? initialsOf(fallbackName(it));
      if (initials) {
        it.initials = initials;
        changed = true;
      }
    }
  }
  return changed;
}

/** The highest number in use, or 0. Appended marks continue after it. */
export function maxNumber(items: ReviewItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.number ?? 0), 0);
}

/** `"#3 VP"`, `"#3"`, or undefined for an item that has not been numbered. */
export function numberLabel(item: ReviewItem): string | undefined {
  if (item.number == null) return undefined;
  return item.initials ? `#${item.number} ${item.initials}` : `#${item.number}`;
}
