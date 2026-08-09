import * as assert from "node:assert";
import {
  parse,
  resolveSourcePath,
  serialize,
  toDocument,
  sha256,
  EMPTY_SHA256,
} from "../model/format.js";
import type { ReviewSession } from "../model/types.js";

const SIDECAR = "/proj/book/chapter-01.review.json";

function sampleSession(): ReviewSession {
  return {
    version: 3,
    sidecarPath: SIDECAR,
    adocPath: "/proj/book/chapter-01.adoc",
    pdfPath: "/proj/book/chapter-01.annotated.pdf",
    revision: { id: "rev-2", ordinal: 2, label: "Copyedit", receivedAt: "2026-07-02" },
    mapping: {
      id: "acme-copyedit",
      kind: "annotations",
      label: "Acme copyedit",
      origin: "Acme Editorial",
      reviewType: "copyedit",
    },
    pdf: { role: "annotated" },
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
  it("serializes to the nested v3 document with a $schema and version", () => {
    const doc = toDocument(sampleSession(), SIDECAR);
    assert.strictEqual(doc.version, 3);
    assert.ok(doc.$schema && doc.$schema.includes("review-v3"));
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

  it("round-trips the round, mapping and PDF-role metadata", () => {
    const before = sampleSession();
    const doc = toDocument(before, SIDECAR);
    assert.strictEqual(doc.revision.id, "rev-2");
    assert.strictEqual(doc.revision.ordinal, 2);
    assert.strictEqual(doc.revision.label, "Copyedit");
    assert.strictEqual(doc.mapping.id, "acme-copyedit");
    assert.strictEqual(doc.mapping.origin, "Acme Editorial");
    assert.strictEqual(doc.mapping.reviewType, "copyedit");
    assert.strictEqual(doc.pdf.role, "annotated");

    const after = parse(serialize(before, SIDECAR), SIDECAR, before.adocPath);
    assert.ok(after);
    assert.deepStrictEqual(after!.revision, before.revision);
    assert.strictEqual(after!.mapping.origin, "Acme Editorial");
    assert.strictEqual(after!.pdf.role, "annotated");
  });

  it("records produced artifacts relative to the sidecar", () => {
    const before = sampleSession();
    before.artifacts = [
      {
        kind: "report",
        path: "/proj/book/.eddie/chapter-01/rev-2/acme-copyedit.review.md",
        createdAt: "2026-07-12T09:10:00.000Z",
      },
    ];
    const text = serialize(before, SIDECAR);
    assert.ok(!text.includes("/proj/"), "no absolute path may leak");
    const after = parse(text, SIDECAR, before.adocPath);
    assert.strictEqual(after!.artifacts?.length, 1);
    assert.strictEqual(after!.artifacts![0].kind, "report");
    assert.strictEqual(
      after!.artifacts![0].path,
      "/proj/book/.eddie/chapter-01/rev-2/acme-copyedit.review.md"
    );
  });

  it("reads the source path a sidecar records, for workspace discovery", () => {
    const text = serialize(sampleSession(), SIDECAR);
    assert.strictEqual(
      resolveSourcePath(text, SIDECAR),
      "/proj/book/chapter-01.adoc"
    );
    assert.strictEqual(resolveSourcePath("{ not json", SIDECAR), undefined);
  });

  it("treats a v2 sidecar as the sole mapping of the first round", () => {
    const v2 = JSON.stringify({
      version: 2,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      source: { path: "chapter-01.adoc" },
      pdf: { path: "chapter-01.annotated.pdf", annotationCount: 1 },
      items: [],
    });
    const session = parse(v2, SIDECAR, "/proj/book/chapter-01.adoc");
    assert.ok(session);
    assert.strictEqual(session!.version, 2); // loaded as v2…
    assert.strictEqual(session!.revision.id, "rev-1");
    assert.strictEqual(session!.revision.ordinal, 1);
    // …named after its own file, which is how the author has been reading it.
    assert.strictEqual(session!.mapping.id, "chapter-01");
    assert.strictEqual(session!.mapping.kind, "annotations");
    assert.strictEqual(session!.pdf.role, "annotated");
    // …and the next write upgrades it in place.
    const doc = toDocument({ ...session!, version: 3 }, SIDECAR);
    assert.strictEqual(doc.version, 3);
    assert.strictEqual(doc.revision.ordinal, 1);
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
    // …and re-serializing upgrades it to a portable v3 doc, in the first round.
    const doc = toDocument({ ...session!, version: 3 }, SIDECAR);
    assert.strictEqual(doc.version, 3);
    assert.strictEqual(doc.pdf.path, "chapter-01.annotated.pdf");
    assert.strictEqual(doc.revision.ordinal, 1);
    assert.strictEqual(doc.mapping.id, "chapter-01");
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

  it("round-trips reply threads and source anchors", () => {
    const before = sampleSession();
    before.items[0].anchor = {
      marker: "a3f21c94",
      blockId: "ch04-figure-anatomy",
      blockFingerprint: "9c1f4e02aa73b518",
      contextBefore: "two debts from earlier chapters",
      contextAfter: "chapter 2 designed a memory system",
    };
    before.items[0].replies = [
      {
        id: "r-7f3a",
        author: "Volodymyr Pavlyshyn",
        createdAt: "2026-08-07T10:14:02.000Z",
        body: "Tightened this — the two debts are now named directly.",
      },
      {
        id: "r-9b21",
        author: "Volodymyr Pavlyshyn",
        createdAt: "2026-08-07T10:20:00.000Z",
        body: "Second pass: also cut the trailing clause.",
      },
    ];

    const doc = toDocument(before, SIDECAR);
    // `anchor` is a sibling of annotation/match/state, not nested inside them.
    assert.strictEqual(doc.items[0].anchor?.marker, "a3f21c94");
    assert.strictEqual(doc.items[0].anchor?.blockId, "ch04-figure-anatomy");
    assert.strictEqual(doc.items[0].state.replies?.length, 2);

    const after = parse(serialize(before, SIDECAR), SIDECAR, before.adocPath);
    assert.ok(after);
    const a0 = after!.items[0];
    assert.deepStrictEqual(a0.anchor, before.items[0].anchor);
    assert.deepStrictEqual(a0.replies, before.items[0].replies);
    // Order is meaningful — a thread reads oldest first.
    assert.strictEqual(a0.replies?.[0].id, "r-7f3a");
    // An item with neither block stays clean rather than gaining empty ones.
    assert.strictEqual(after!.items[1].anchor, undefined);
    assert.strictEqual(after!.items[1].replies, undefined);
  });

  it("omits empty anchors and reply lists rather than writing husks", () => {
    const s = sampleSession();
    s.items[0].anchor = {}; // every field unset
    s.items[0].replies = [];
    const doc = toDocument(s, SIDECAR);
    assert.ok(!("anchor" in doc.items[0]));
    assert.strictEqual(doc.items[0].state.replies, undefined);
    // Match the JSON key, not the bare word — `anchoredText` contains it.
    const text = serialize(s, SIDECAR);
    assert.ok(!/"anchor"\s*:/.test(text));
    assert.ok(!/"replies"\s*:/.test(text));
  });

  it("accepts the deterministic match methods", () => {
    const s = sampleSession();
    s.items[0].match = {
      startLine: 6,
      endLine: 7,
      score: 1,
      method: "marker",
      sourceExcerpt: "x",
    };
    const after = parse(serialize(s, SIDECAR), SIDECAR, s.adocPath);
    assert.strictEqual(after!.items[0].match?.method, "marker");
  });

  it("migrates a v1 sidecar to items with no replies or anchor", () => {
    const v1 = JSON.stringify({
      version: 1,
      adocPath: "/old/chapter-01.adoc",
      pdfPath: "/proj/book/chapter-01.annotated.pdf",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      items: [
        {
          id: "p1-highlight-1-1",
          kind: "highlight",
          page: 1,
          rect: [0, 0, 1, 1],
          match: null,
          resolved: false,
        },
      ],
    });
    const session = parse(v1, SIDECAR, "/proj/book/chapter-01.adoc");
    assert.ok(session);
    assert.strictEqual(session!.items[0].replies, undefined);
    assert.strictEqual(session!.items[0].anchor, undefined);
    // And upgrading it writes a valid v2 item without empty blocks.
    const doc = toDocument({ ...session!, version: 3 }, SIDECAR);
    assert.ok(!("anchor" in doc.items[0]));
  });

  // A zero-byte digest never means "the file was empty" — it means the hash ran
  // over a buffer pdfjs had already detached. Writing it out would report a
  // perfectly good session as permanently stale.
  it("never writes the zero-byte digest as a fingerprint", () => {
    const s = sampleSession();
    s.integrity = { ...s.integrity, pdfSha256: EMPTY_SHA256 };
    const doc = toDocument(s, SIDECAR);
    assert.strictEqual(doc.pdf.sha256, undefined);
    // The real source digest beside it is untouched.
    assert.strictEqual(doc.source.sha256, "a".repeat(64));
    // And it must not survive into the serialized text at all.
    assert.ok(!serialize(s, SIDECAR).includes(EMPTY_SHA256));
  });

  it("ignores the zero-byte digest in sidecars already written with it", () => {
    const doc = JSON.stringify({
      version: 2,
      createdAt: "2026-08-04T06:22:01.958Z",
      updatedAt: "2026-08-04T07:42:18.092Z",
      source: { path: "chapter-01.adoc", sha256: "a".repeat(64), bytes: 71060 },
      pdf: {
        path: "chapter-01.annotated.pdf",
        sha256: EMPTY_SHA256,
        annotationCount: 45,
      },
      items: [],
    });
    const session = parse(doc, SIDECAR, "/proj/book/chapter-01.adoc");
    assert.ok(session);
    assert.strictEqual(session!.integrity?.pdfSha256, undefined);
    // The rest of the integrity block still loads.
    assert.strictEqual(session!.integrity?.sourceSha256, "a".repeat(64));
    assert.strictEqual(session!.integrity?.pdfAnnotationCount, 45);
  });
});
