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

/**
 * The delimiter character opening a *verbatim* block — one whose body is
 * content, not markup: listing (`----`), literal (`....`), passthrough (`++++`)
 * and fenced code (```` ``` ````).
 *
 * Example (`====`), sidebar (`****`) and quote (`____`) blocks are deliberately
 * absent: they hold prose, so a `//` line inside one really is a comment and
 * Asciidoctor really does strip it.
 */
function verbatimDelimiter(trimmed: string): string | undefined {
  if (/^(-{4,}|\.{4,}|\+{4,})$/.test(trimmed)) return trimmed[0];
  if (/^`{3,}$/.test(trimmed)) return "`";
  return undefined;
}

/** True when this line opens or closes a verbatim block. */
export function isVerbatimDelimiter(line: string): boolean {
  return verbatimDelimiter(line.trim()) !== undefined;
}

/**
 * Per-line flags marking every line of every verbatim block, delimiters
 * included.
 *
 * Inside one of these a `//` line is *code*, which Asciidoctor renders as
 * written. That makes verbatim blocks the one place a marker comment must never
 * be written — it would appear in the delivered PDF — and the one place a
 * marker-shaped line must never be believed: a Go or JavaScript sample may
 * legitimately contain `// eddie:deadbeef`, and reading it as an anchor
 * fabricates a binding to code the editor never marked.
 *
 * Pairing is by delimiter character rather than exact length, which is what real
 * manuscripts do; nesting the same character is rare enough that closing on the
 * first match is the more predictable answer.
 */
export function verbatimLineFlags(rawLines: string[]): boolean[] {
  const flags: boolean[] = new Array(rawLines.length).fill(false);
  let open: string | undefined;
  for (let i = 0; i < rawLines.length; i++) {
    const delim = verbatimDelimiter(rawLines[i].trim());
    if (open !== undefined) {
      flags[i] = true; // the closing delimiter belongs to the block it closes
      if (delim === open) open = undefined;
      continue;
    }
    if (delim !== undefined) {
      open = delim;
      flags[i] = true;
    }
  }
  return flags;
}

/**
 * Per-line comment flags for a whole document: `//` line comments, `////`
 * block-comment delimiters, and every line inside a `////` block. Comment text
 * never reaches the rendered PDF, so flagged lines must never be match
 * targets. Block comments need this stateful pass — the per-line
 * {@link isStructuralLine} cannot know it is standing inside one.
 */
export function commentLineFlags(rawLines: string[]): boolean[] {
  const flags: boolean[] = new Array(rawLines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (/^\/{4,}$/.test(t)) {
      flags[i] = true;
      inBlock = !inBlock;
      continue;
    }
    flags[i] = inBlock || t.startsWith("//");
  }
  return flags;
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
