/**
 * Stamping is verified by writing a PDF and reading it back with pdf-lib, so
 * the assertions are about what actually landed in the file rather than about
 * the code's intentions. pdfjs is deliberately not used here: it needs a worker
 * file beside the bundle, which the plain `out/` test build does not have.
 */
import * as assert from "node:assert";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { stampPdf } from "../pdf/stamp.js";
import type { AnchoredItem, Precision } from "../pdf/anchor.js";
import type { ReviewItem } from "../model/types.js";

/** A blank one-page PDF to stamp into. */
async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "p1-highlight-48-287",
    kind: "highlight",
    page: 1,
    comment: "Strong framing — keep this.",
    anchoredText: "relationships at the center of the model",
    author: "Rachel",
    rect: [0, 0, 0, 0],
    match: { startLine: 6, endLine: 6, score: 1, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

function placed(it: ReviewItem, precision: Precision = "exact"): AnchoredItem {
  return {
    item: it,
    precision,
    hit: {
      page: 1,
      rect: [100, 500, 300, 512],
      quadPoints: [100, 512, 300, 512, 100, 500, 300, 500],
      score: 1,
    },
  };
}

/** Every annotation dictionary in the saved file. */
async function annotationsOf(bytes: Uint8Array): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes);
  const out: PDFDict[] = [];
  for (const page of doc.getPages()) {
    const arr = page.node.lookup(PDFName.of("Annots"));
    if (!(arr instanceof PDFArray)) continue;
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookup(i);
      if (d instanceof PDFDict) out.push(d);
    }
  }
  return out;
}

function str(d: PDFDict, key: string): string | undefined {
  const v = d.lookup(PDFName.of(key));
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

function name(d: PDFDict, key: string): string | undefined {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.asString().replace(/^\//, "") : undefined;
}

function num(d: PDFDict, key: string): number | undefined {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

describe("stampPdf", () => {
  it("writes a markup annotation with the editor's text and author", async () => {
    const r = await stampPdf(await blankPdf(), [placed(item())]);
    assert.strictEqual(r.marks, 1);
    const [a] = await annotationsOf(r.bytes);
    assert.strictEqual(name(a, "Subtype"), "Highlight");
    assert.strictEqual(str(a, "T"), "Rachel");
    assert.strictEqual(str(a, "Contents"), "Strong framing — keep this.");
  });

  it("carries the sidecar item id in /NM so the next round can rejoin state", async () => {
    const r = await stampPdf(await blankPdf(), [placed(item())]);
    const [a] = await annotationsOf(r.bytes);
    assert.strictEqual(str(a, "NM"), "p1-highlight-48-287");
  });

  it("gives every annotation an appearance stream", async () => {
    // Without /AP, Preview.app renders a markup annotation as nothing at all.
    const kinds: ReviewItem["kind"][] = [
      "highlight",
      "strikeout",
      "underline",
      "comment",
      "insert",
    ];
    const r = await stampPdf(
      await blankPdf(),
      kinds.map((kind, i) => placed(item({ id: `i${i}`, kind })))
    );
    const annots = await annotationsOf(r.bytes);
    assert.strictEqual(annots.length, kinds.length);
    for (const a of annots) {
      const ap = a.lookup(PDFName.of("AP"));
      assert.ok(ap instanceof PDFDict, "annotation has an /AP dictionary");
      assert.ok(
        ap.get(PDFName.of("N")) instanceof PDFRef,
        "/AP has a normal appearance stream"
      );
    }
  });

  it("writes QuadPoints for text markup but not for notes or carets", async () => {
    const marks = await stampPdf(await blankPdf(), [
      placed(item({ id: "h", kind: "highlight" })),
      placed(item({ id: "c", kind: "comment" })),
      placed(item({ id: "i", kind: "insert" })),
    ]);
    const [h, c, i] = await annotationsOf(marks.bytes);
    assert.ok(h.lookup(PDFName.of("QuadPoints")) instanceof PDFArray);
    assert.strictEqual(c.lookup(PDFName.of("QuadPoints")), undefined);
    assert.strictEqual(i.lookup(PDFName.of("QuadPoints")), undefined);
  });

  it("writes replies as /IRT threads pointing at their parent", async () => {
    const withReplies = item({
      replies: [
        { id: "r-1", author: "Volodymyr", createdAt: "2026-08-09T10:00:00Z", body: "Fixed." },
        { id: "r-2", author: "Volodymyr", createdAt: "2026-08-09T11:00:00Z", body: "Tightened further." },
      ],
    });
    const r = await stampPdf(await blankPdf(), [placed(withReplies)]);
    assert.strictEqual(r.marks, 1);
    assert.strictEqual(r.replies, 2);

    const annots = await annotationsOf(r.bytes);
    const replies = annots.filter((a) => a.has(PDFName.of("IRT")));
    assert.strictEqual(replies.length, 2);
    for (const rep of replies) {
      assert.strictEqual(name(rep, "RT"), "R");
      assert.strictEqual(name(rep, "Subtype"), "Text");
      assert.ok(rep.get(PDFName.of("IRT")) instanceof PDFRef);
    }
    assert.deepStrictEqual(
      replies.map((x) => str(x, "Contents")),
      ["Fixed.", "Tightened further."]
    );
  });

  it("dims resolved marks and flags them in the comment", async () => {
    const r = await stampPdf(await blankPdf(), [
      placed(item({ id: "open" })),
      placed(item({ id: "done", resolved: true })),
    ]);
    const [open, done] = await annotationsOf(r.bytes);
    assert.strictEqual(num(open, "CA"), 1);
    assert.strictEqual(num(done, "CA"), 0.25);
    assert.match(str(done, "Contents")!, /^\[resolved\]/);
  });

  it("can leave resolved marks out entirely", async () => {
    const r = await stampPdf(
      await blankPdf(),
      [placed(item({ id: "open" })), placed(item({ id: "done", resolved: true }))],
      { includeResolved: false }
    );
    assert.strictEqual(r.marks, 1);
    assert.strictEqual(r.skippedResolved, 1);
  });

  // A strikeout says "delete these words". If the words are gone and the mark
  // can only be placed on the paragraph, drawing a strikeout over all of it
  // would ask the editor to delete text she never marked.
  describe("degraded word-level marks", () => {
    const stale = item({
      kind: "strikeout",
      markedText: "and it is worth naming them up front",
      comment: "Please avoid narrating what you are about to do.",
    });

    it("is not drawn as a strikeout across the whole paragraph", async () => {
      const r = await stampPdf(await blankPdf(), [placed(stale, "line")]);
      const [a] = await annotationsOf(r.bytes);
      assert.strictEqual(name(a, "Subtype"), "Highlight");
    });

    it("says in words what the original mark was", async () => {
      const r = await stampPdf(await blankPdf(), [placed(stale, "line")]);
      const [a] = await annotationsOf(r.bytes);
      const contents = str(a, "Contents")!;
      assert.match(contents, /delete .*rewritten/i);
      assert.match(contents, /and it is worth naming them up front/);
      assert.match(contents, /Please avoid narrating/);
    });

    it("keeps the deletion colour and fades the wash", async () => {
      const r = await stampPdf(await blankPdf(), [placed(stale, "line")]);
      const [a] = await annotationsOf(r.bytes);
      const c = a.lookup(PDFName.of("C")) as PDFArray;
      assert.ok((c.lookup(0) as PDFNumber).asNumber() > 0.9, "still red");
      assert.strictEqual(num(a, "CA"), 0.35);
    });

    it("leaves an exactly-placed strikeout as a real strikeout", async () => {
      const r = await stampPdf(await blankPdf(), [placed(stale, "exact")]);
      const [a] = await annotationsOf(r.bytes);
      assert.strictEqual(name(a, "Subtype"), "StrikeOut");
      assert.strictEqual(num(a, "CA"), 1);
      assert.strictEqual(str(a, "Contents"), stale.comment);
    });

    it("still widens a highlight without commentary", async () => {
      // A highlight means "look here", so covering the paragraph loses nothing.
      const r = await stampPdf(await blankPdf(), [placed(item(), "line")]);
      const [a] = await annotationsOf(r.bytes);
      assert.strictEqual(name(a, "Subtype"), "Highlight");
      assert.strictEqual(str(a, "Contents"), "Strong framing — keep this.");
    });
  });

  // A note carries no anchored text, so re-importing recovers its line by
  // measuring from its rect. Give it the paragraph's rect and that measurement
  // lands somewhere else — the round-trip fixture moved a note from line 18 to
  // line 14 this way.
  it("gives a sticky note an icon-sized rect, not the paragraph's", async () => {
    const note = placed(item({ kind: "comment" }));
    const wide = placed(item({ id: "h", kind: "highlight" }));
    const r = await stampPdf(await blankPdf(), [note, wide]);
    const [n, h] = await annotationsOf(r.bytes);

    const rectOf = (d: PDFDict) => {
      const a = d.lookup(PDFName.of("Rect")) as PDFArray;
      return [0, 1, 2, 3].map((i) => (a.lookup(i) as PDFNumber).asNumber());
    };
    const [nx0, ny0, nx1, ny1] = rectOf(n);
    const [hx0, , hx1] = rectOf(h);

    assert.ok(nx1 - nx0 <= 20, "note is icon-width");
    assert.ok(ny1 - ny0 <= 20, "note is icon-height");
    assert.ok(hx1 - hx0 > 100, "the highlight still spans its words");
    // The icon sits beside the start of the line, not over the text.
    assert.ok(nx1 <= hx0, "note is to the left of the marked text");
  });

  it("encodes non-Latin-1 comment text without mangling it", async () => {
    const cyrillic = item({ comment: "Знання — це граф, а не таблиця." });
    const r = await stampPdf(await blankPdf(), [placed(cyrillic)]);
    const [a] = await annotationsOf(r.bytes);
    assert.strictEqual(str(a, "Contents"), "Знання — це граф, а не таблиця.");
  });

  it("leaves the page's existing annotations alone", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(
      PDFName.of("Annots"),
      doc.context.obj([
        doc.context.register(
          doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 1, 1] })
        ),
      ])
    );
    const r = await stampPdf(await doc.save(), [placed(item())]);
    const annots = await annotationsOf(r.bytes);
    assert.strictEqual(annots.length, 2);
    assert.ok(annots.some((a) => name(a, "Subtype") === "Link"));
    assert.ok(annots.some((a) => name(a, "Subtype") === "Highlight"));
  });

  it("skips a hit that points past the end of the document", async () => {
    const off = placed(item());
    off.hit = { ...off.hit, page: 99 };
    const r = await stampPdf(await blankPdf(), [off]);
    assert.strictEqual(r.marks, 0);
    assert.strictEqual((await annotationsOf(r.bytes)).length, 0);
  });
});
