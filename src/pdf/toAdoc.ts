import * as path from "node:path";
import type { RawAnnotation } from "../model/types.js";
import { KIND_LABEL } from "../model/types.js";

/** Escape a value so it is safe inside an AsciiDoc attribute / inline context. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render extracted PDF annotations as a standalone AsciiDoc document — one
 * section per page, each annotation carrying its anchored context text (the
 * same text the review mapper uses) plus the reviewer's comment and author.
 * This is a read-only export; it never touches the source .adoc.
 */
export function annotationsToAdoc(
  pdfPath: string,
  annots: RawAnnotation[],
  generatedAt: string
): string {
  const title = path.basename(pdfPath);
  const lines: string[] = [
    `= Annotations: ${inline(title)}`,
    `:source-pdf: ${title}`,
    `:generated: ${generatedAt}`,
    `:annotation-count: ${annots.length}`,
    "",
    `Extracted ${annots.length} annotation(s) from \`${inline(title)}\`.`,
    "",
  ];

  if (annots.length === 0) {
    lines.push("No annotations found in this PDF.", "");
    return lines.join("\n");
  }

  // Group by page, preserving first-seen order within each page.
  const byPage = new Map<number, RawAnnotation[]>();
  for (const a of annots) {
    const bucket = byPage.get(a.page) ?? [];
    bucket.push(a);
    byPage.set(a.page, bucket);
  }

  for (const page of [...byPage.keys()].sort((x, y) => x - y)) {
    lines.push(`== Page ${page}`, "");
    for (const a of byPage.get(page)!) {
      const label = KIND_LABEL[a.kind] ?? a.kind;
      lines.push(`=== ${label}${a.author ? ` — ${inline(a.author)}` : ""}`, "");

      const context = inline(a.markedText || a.anchoredText);
      if (context) {
        lines.push("Context:", "", "[quote]", "____", context, "____", "");
      }
      if (a.comment) {
        lines.push(`Comment:: ${inline(a.comment)}`, "");
      }
      if (!context && !a.comment) {
        lines.push("_(no anchored text or comment)_", "");
      }
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Default output path for a PDF's extracted annotations. */
export function extractedAdocPath(pdfPath: string): string {
  const base = pdfPath.replace(/(\.annotated)?\.pdf$/i, "");
  return `${base}.annotations.adoc`;
}
