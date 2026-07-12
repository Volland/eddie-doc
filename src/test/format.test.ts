import * as assert from "node:assert";
import { parse, serialize, toDocument, sha256 } from "../model/format.js";
import type { ReviewSession } from "../model/types.js";

const SIDECAR = "/proj/book/chapter-01.review.json";

function sampleSession(): ReviewSession {
  return {
    version: 2,
    adocPath: "/proj/book/chapter-01.adoc",
    pdfPath: "/proj/book/chapter-01.annotated.pdf",
    createdAt: "2026-07-03T07:15:17.937Z",
    updatedAt: "2026-07-12T09:00:00.000Z",
    integrity: {
      sourceSha256: "a".repeat(64),
      sourceBytes: 4213,
      pdfSha256: "b".repeat(64),
      pdfAnnotationCount: 2,
    },
    items: [
      {
        id: "p2-highlight-48-719",
        kind: "highlight",
        page: 2,
        comment: "Keep this.",
        anchoredText: "relationships at the center of the model.",
        markedText: "relationships at the center of the model",
        author: "Editor",
        rect: [48.24, 718.58, 547.04, 748.64],
        match: {
          startLine: 6,
          endLine: 7,
          score: 0.887,
          sourceExcerpt: "…at the center of the model.",
          method: "fuzzy",
        },
        resolved: false,
      },
      {
        id: "p3-comment-527-705",
        kind: "comment",
        page: 3,
        comment: "Add a diagram.",
        anchoredText: "An entity is any distinct thing",
        rect: [527.06, 704.86, 543.06, 720.86],
        match: null,
        resolved: true,
        manualLine: 14,
        confirmed: true,
        note: "linked by hand",
      },
    ],
  };
}

describe("review format", () => {
  it("serializes to the nested v2 document with a $schema and version", () => {
    const doc = toDocument(sampleSession(), SIDECAR);
    assert.strictEqual(doc.version, 2);
    assert.ok(doc.$schema && doc.$schema.includes("review-v2"));
    // Nested item shape.
    const it = doc.items[0];
    assert.strictEqual(it.annotation.kind, "highlight");
    assert.strictEqual(it.annotation.geometry.page, 2);
    assert.strictEqual(it.annotation.geometry.unit, "pt");
    assert.strictEqual(it.annotation.geometry.origin, "bottom-left");
    assert.strictEqual(it.match?.startLine, 6);
    assert.strictEqual(it.state.resolved, false);
  });

  it("uses paths relative to the sidecar, not absolute", () => {
    const doc = toDocument(sampleSession(), SIDECAR);
    assert.strictEqual(doc.source.path, "chapter-01.adoc");
    assert.strictEqual(doc.pdf.path, "chapter-01.annotated.pdf");
    assert.strictEqual(doc.source.sha256, "a".repeat(64));
    assert.strictEqual(doc.pdf.annotationCount, 2);
    // No absolute path leaks into the serialized text.
    assert.ok(!serialize(sampleSession(), SIDECAR).includes("/proj/"));
  });

  it("round-trips a session through serialize + parse", () => {
    const before = sampleSession();
    const after = parse(serialize(before, SIDECAR), SIDECAR, before.adocPath);
    assert.ok(after);
    assert.strictEqual(after!.adocPath, before.adocPath);
    // pdfPath is reconstructed from the relative path + sidecar dir.
    assert.strictEqual(after!.pdfPath, before.pdfPath);
    assert.strictEqual(after!.items.length, 2);
    const a0 = after!.items[0];
    assert.strictEqual(a0.kind, "highlight");
    assert.strictEqual(a0.page, 2);
    assert.strictEqual(a0.match?.score, 0.887);
    const a1 = after!.items[1];
    assert.strictEqual(a1.match, null);
    assert.strictEqual(a1.manualLine, 14);
    assert.strictEqual(a1.confirmed, true);
    assert.strictEqual(a1.resolved, true);
    assert.strictEqual(a1.note, "linked by hand");
    assert.deepStrictEqual(after!.integrity, before.integrity);
  });

  it("migrates a legacy v1 sidecar and drops absolute paths on rewrite", () => {
    const v1 = JSON.stringify({
      version: 1,
      adocPath: "/old/machine/chapter-01.adoc",
      pdfPath: "/proj/book/chapter-01.annotated.pdf",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      items: [
        {
          id: "p2-highlight-48-719",
          kind: "highlight",
          page: 2,
          comment: "Keep this.",
          anchoredText: "relationships at the center of the model.",
          rect: [48.24, 718.58, 547.04, 748.64],
          match: { startLine: 6, endLine: 7, score: 0.88, sourceExcerpt: "x" },
          resolved: true,
        },
      ],
    });
    const session = parse(v1, SIDECAR, "/proj/book/chapter-01.adoc");
    assert.ok(session);
    assert.strictEqual(session!.version, 1); // loaded as v1…
    assert.strictEqual(session!.items[0].resolved, true);
    // …and re-serializing upgrades it to a portable v2 doc.
    const doc = toDocument({ ...session!, version: 2 }, SIDECAR);
    assert.strictEqual(doc.version, 2);
    assert.strictEqual(doc.pdf.path, "chapter-01.annotated.pdf");
  });

  it("returns null for corrupt or unknown input", () => {
    assert.strictEqual(parse("{ not json", SIDECAR, "/a.adoc"), null);
    assert.strictEqual(parse("{}", SIDECAR, "/a.adoc"), null);
    assert.strictEqual(parse('{"version":99}', SIDECAR, "/a.adoc"), null);
  });

  it("computes a stable sha256 hex digest", () => {
    const d = sha256(new Uint8Array([1, 2, 3]));
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.strictEqual(d, sha256(new Uint8Array([1, 2, 3])));
  });
});
