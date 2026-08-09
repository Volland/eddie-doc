import * as assert from "node:assert";
import * as path from "node:path";
import {
  documentFolder,
  isInReviewFolder,
  legacySidecarPath,
  mappingIdFromPdf,
  mappingReportPath,
  mappingSidecarPath,
  pdfFolder,
  reviewRoot,
  revisionId,
  revisionOrdinal,
  slug,
  uniqueId,
  type LayoutConfig,
} from "../model/layout.js";

const CFG: LayoutConfig = {
  workspaceRoot: "/proj",
  reviewFolder: ".eddie",
};

/** Compare with the platform's separators so the tests pass on Windows too. */
function p(...parts: string[]): string {
  return path.join(...parts);
}

describe("review folder layout", () => {
  it("puts the review root at the workspace root", () => {
    assert.strictEqual(reviewRoot(CFG), p("/proj", ".eddie"));
  });

  it("honours an absolute review folder", () => {
    assert.strictEqual(
      reviewRoot({ workspaceRoot: "/proj", reviewFolder: "/var/reviews" }),
      path.normalize("/var/reviews")
    );
  });

  it("selects the legacy layout when the setting is empty", () => {
    const legacy = { workspaceRoot: "/proj", reviewFolder: "  " };
    assert.strictEqual(reviewRoot(legacy), undefined);
    assert.strictEqual(
      documentFolder(legacy, "/proj/manuscript/chapter-01.adoc"),
      undefined
    );
  });

  it("mirrors the manuscript tree so same-named chapters cannot collide", () => {
    const a = documentFolder(CFG, "/proj/part-1/chapter-01.adoc");
    const b = documentFolder(CFG, "/proj/part-2/chapter-01.adoc");
    assert.strictEqual(a, p("/proj", ".eddie", "part-1", "chapter-01"));
    assert.strictEqual(b, p("/proj", ".eddie", "part-2", "chapter-01"));
    assert.notStrictEqual(a, b);
  });

  it("keeps a source outside the workspace inside the review root", () => {
    const folder = documentFolder(CFG, "/elsewhere/notes/appendix.adoc");
    assert.ok(folder);
    assert.ok(
      folder!.startsWith(p("/proj", ".eddie")),
      `escaped the review root: ${folder}`
    );
    assert.ok(!folder!.includes(".."));
  });

  it("names revisions by round number, and reads them back", () => {
    assert.strictEqual(revisionId(1), "rev-1");
    assert.strictEqual(revisionId(12), "rev-12");
    assert.strictEqual(revisionOrdinal("rev-12"), 12);
    assert.strictEqual(revisionOrdinal("rev-x"), undefined);
    assert.strictEqual(revisionOrdinal("chapter-01"), undefined);
  });

  it("lays a revision's files out under its own folder", () => {
    const folder = documentFolder(CFG, "/proj/manuscript/chapter-01.adoc")!;
    assert.strictEqual(
      mappingSidecarPath(folder, "rev-2", "acme-copyedit"),
      p(folder, "rev-2", "acme-copyedit.review.json")
    );
    assert.strictEqual(
      mappingReportPath(folder, "rev-2", "acme-copyedit"),
      p(folder, "rev-2", "acme-copyedit.review.md")
    );
    assert.strictEqual(pdfFolder(folder, "rev-2"), p(folder, "rev-2", "pdf"));
  });

  it("derives a mapping id from the PDF an author recognizes it by", () => {
    assert.strictEqual(
      mappingIdFromPdf("/in/Acme Copyedit.annotated.pdf"),
      "acme-copyedit"
    );
    assert.strictEqual(mappingIdFromPdf("/in/ch01.reviewed.pdf"), "ch01");
    // Cyrillic and other non-ASCII names still yield a usable folder name.
    assert.ok(mappingIdFromPdf("/in/розділ.pdf").length > 0);
  });

  it("disambiguates two PDFs that slug the same within one round", () => {
    const first = mappingIdFromPdf("/a/copyedit.pdf", []);
    const second = mappingIdFromPdf("/b/copyedit.pdf", [first]);
    const third = mappingIdFromPdf("/c/copyedit.pdf", [first, second]);
    assert.deepStrictEqual([first, second, third], [
      "copyedit",
      "copyedit-2",
      "copyedit-3",
    ]);
    assert.strictEqual(uniqueId("x", []), "x");
  });

  it("slugs to safe path components", () => {
    assert.strictEqual(slug("Acme Editorial — Round 2"), "acme-editorial-round-2");
    assert.strictEqual(slug("///"), "untitled");
  });

  it("keeps the legacy sidecar path for both AsciiDoc extensions", () => {
    assert.strictEqual(
      legacySidecarPath("/proj/book/chapter-01.adoc"),
      "/proj/book/chapter-01.review.json"
    );
    assert.strictEqual(
      legacySidecarPath("/proj/book/chapter-01.asciidoc"),
      "/proj/book/chapter-01.review.json"
    );
  });

  it("tells review-folder files from manuscript files", () => {
    assert.ok(isInReviewFolder(CFG, p("/proj", ".eddie", "a", "rev-1", "x.review.json")));
    assert.ok(!isInReviewFolder(CFG, "/proj/manuscript/chapter-01.review.json"));
    assert.ok(!isInReviewFolder({ reviewFolder: "" }, "/proj/x.review.json"));
  });
});
