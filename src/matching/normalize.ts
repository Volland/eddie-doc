/**
 * Reduce AsciiDoc source and PDF-extracted text to comparable token streams.
 * The goal is not a faithful AsciiDoc parse — it is to strip syntax noise so a
 * highlighted phrase in the PDF lines up with the words in the source.
 */

const INLINE_STRIP: Array<[RegExp, string]> = [
  // xref / links: keep the visible label, drop the target.
  [/xref:[^\[]*\[([^\]]*)\]/g, " $1 "],
  [/link:[^\[]*\[([^\]]*)\]/g, " $1 "],
  [/https?:\/\/\S+\[([^\]]*)\]/g, " $1 "],
  [/https?:\/\/\S+/g, " "],
  // footnotes, cross refs, anchors.
  [/footnote:[^\[]*\[[^\]]*\]/g, " "],
  [/<<[^>]*>>/g, " "],
  [/\[\[[^\]]*\]\]/g, " "],
  // inline attributes/roles like [.lead] or {attr}.
  [/\{[a-zA-Z0-9_-]+\}/g, " "],
  // passthrough + monospace/bold/italic/super/sub markers.
  [/[*_`^~#]+/g, " "],
  // image/icon macros.
  [/i(?:mage|con):[^\[]*\[[^\]]*\]/g, " "],
];

/** Lines that carry no prose and should never be a match target. */
export function isStructuralLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^[=\-.*_+/]{4,}$/.test(t)) return true; // block delimiters ---- ==== ....
  if (/^\[[^\]]*\]$/.test(t)) return true; // [source,ruby], [.lead], [NOTE]
  if (/^:[^:]+:/.test(t)) return true; // :attribute: value
  if (/^\/\//.test(t)) return true; // // comment
  if (/^ifdef::|^ifndef::|^endif::|^include::/.test(t)) return true;
  return false;
}

/** Strip a leading AsciiDoc block/prose marker, returning the prose remainder. */
function stripLeadMarkers(line: string): string {
  return line
    .replace(/^\s*={1,6}\s+/, "") // section titles
    .replace(/^\s*[*\-.]+\s+/, "") // unordered / ordered lists
    .replace(/^\s*\d+\.\s+/, "") // numbered list
    .replace(/^\s*\[[A-Z]+\]\s*/, "") // inline admonition label
    .replace(/^\s*(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+/, "")
    .replace(/^\s*\|=*/, "") // table cell/format
    .replace(/^\s*<\d+>\s*/, ""); // callout
}

export function normalizeText(input: string): string {
  let s = " " + input + " ";
  for (const [re, rep] of INLINE_STRIP) s = s.replace(re, rep);
  s = s.toLowerCase();
  // Keep letters/digits (incl. Cyrillic & other Unicode letters) and spaces.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function tokenize(input: string): string[] {
  const n = normalizeText(input);
  return n ? n.split(" ") : [];
}

/** Tokenize a single source line after removing prose-leading markers. */
export function tokenizeSourceLine(line: string): string[] {
  if (isStructuralLine(line)) return [];
  return tokenize(stripLeadMarkers(line));
}
