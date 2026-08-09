import * as assert from "node:assert";
import type { PageText, PositionedText } from "../pdf/extract.js";
import { buildPdfIndex, locateInPdf } from "../pdf/locate.js";

/**
 * Build a page of rendered lines. Each line is one text run, as asciidoctor-pdf
 * emits them: a whole justified line, top-to-bottom down the page.
 */
function page(n: number, lines: string[], opts: { x0?: number } = {}): PageText {
  const x0 = opts.x0 ?? 50;
  const lineHeight = 14;
  const top = 700;
  const charWidth = 5;
  const texts: PositionedText[] = lines.map((str, i) => ({
    str,
    box: {
      x0,
      x1: x0 + str.length * charWidth,
      y0: top - i * lineHeight,
      y1: top - i * lineHeight + 10,
    },
  }));
  return { page: n, height: 792, width: 612, texts };
}

const CHAPTER = [
  page(1, [
    "Two debts from earlier chapters come due here. Chapter 2 designed a",
    "memory system in the abstract: tiered stores governed by an executive.",
    "Entities are stable and reusable across the graph.",
  ]),
  page(2, [
    "An agent is assembled from eight parts, and the loop that drives them.",
    "Entities are stable and reusable across the graph.",
  ]),
];

const idx = buildPdfIndex(CHAPTER);

describe("locateInPdf", () => {
  it("finds a phrase within one rendered line and scores it exact", () => {
    const hits = locateInPdf("tiered stores governed by an executive", idx);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].score, 1);
    assert.strictEqual(hits[0].page, 1);
    assert.strictEqual(hits[0].quadPoints.length, 8, "one line -> one quad");
  });

  it("is insensitive to case, punctuation and whitespace", () => {
    const hits = locateInPdf("  TIERED   stores, governed by an EXECUTIVE!  ", idx);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].score, 1);
  });

  it("emits one quad per rendered line for a phrase that wraps", () => {
    const hits = locateInPdf(
      "Chapter 2 designed a memory system in the abstract",
      idx
    );
    assert.strictEqual(hits[0].score, 1);
    assert.strictEqual(hits[0].quadPoints.length, 16, "two lines -> two quads");
    // The two quads sit on different baselines, upper one first.
    const y1a = hits[0].quadPoints[1];
    const y1b = hits[0].quadPoints[9];
    assert.ok(y1a > y1b, "quads run top to bottom");
  });

  it("returns a rect that encloses every quad", () => {
    const [hit] = locateInPdf(
      "Chapter 2 designed a memory system in the abstract",
      idx
    );
    const [x0, y0, x1, y1] = hit.rect;
    for (let i = 0; i + 7 < hit.quadPoints.length; i += 8) {
      const qx = hit.quadPoints.slice(i, i + 8).filter((_, k) => k % 2 === 0);
      const qy = hit.quadPoints.slice(i, i + 8).filter((_, k) => k % 2 === 1);
      assert.ok(Math.min(...qx) >= x0 - 1e-6 && Math.max(...qx) <= x1 + 1e-6);
      assert.ok(Math.min(...qy) >= y0 - 1e-6 && Math.max(...qy) <= y1 + 1e-6);
    }
  });

  it("keeps quads inside the run's own box", () => {
    const [hit] = locateInPdf("Two debts from earlier chapters", idx);
    const run = CHAPTER[0].texts[0].box;
    for (let i = 0; i + 7 < hit.quadPoints.length; i += 8) {
      assert.ok(hit.quadPoints[i] >= run.x0 - 1e-6);
      assert.ok(hit.quadPoints[i + 2] <= run.x1 + 1e-6);
    }
  });

  it("narrows to the marked words, not the whole line", () => {
    const line = CHAPTER[0].texts[0].box;
    const [hit] = locateInPdf("Chapter 2 designed a", idx);
    assert.ok(hit.rect[0] > line.x0, "starts after the line's left edge");
    assert.ok(hit.rect[2] <= line.x1 + 1e-6);
  });

  it("reports every occurrence across pages, in page order", () => {
    const hits = locateInPdf("Entities are stable and reusable", idx);
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map((h) => h.page).sort(), [1, 2]);
  });

  it("scopes the search to one page when asked", () => {
    const hits = locateInPdf("Entities are stable and reusable", idx, { page: 2 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].page, 2);
  });

  it("finds nothing for text that is not in the document", () => {
    assert.deepStrictEqual(
      locateInPdf("bananas were never mentioned anywhere here", idx),
      []
    );
    assert.deepStrictEqual(locateInPdf("   ", idx), []);
  });

  it("rejoins a word broken by a line-break hyphen", () => {
    const hyphenated = buildPdfIndex([
      page(1, ["the memory life-", "cycle is what matters"]),
    ]);
    const hits = locateInPdf("memory lifecycle is what matters", hyphenated);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].score, 1);
    assert.strictEqual(hits[0].quadPoints.length, 16);
  });

  it("does not glue together words that merely end a line", () => {
    // Without a hyphen the runs are separate words: "an executive" + "Entities"
    // must not normalize into "executiveentities".
    assert.deepStrictEqual(locateInPdf("executiveentities", idx), []);
    assert.strictEqual(
      locateInPdf("an executive Entities are stable", idx)[0]?.score,
      1
    );
  });

  // A page-bounded index cannot match a query longer than the page, so long
  // phrases are anchored by a bounded probe and then extended.
  describe("long phrases", () => {
    const long = buildPdfIndex([
      page(1, [
        "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        "nu xi omicron pi rho sigma tau upsilon phi chi psi omega and more",
        "text continuing well past any reasonable probe length on this page",
      ]),
    ]);

    it("covers the full phrase when it fits on one page", () => {
      const phrase = CHAPTER[0].texts.slice(0, 2).map((t) => t.str).join(" ");
      const [hit] = locateInPdf(phrase, idx);
      assert.strictEqual(hit.score, 1);
      assert.strictEqual(hit.quadPoints.length, 16, "both lines covered");
    });

    it("anchors a phrase far longer than the probe", () => {
      const phrase = long.pages[0].norm; // the whole page, ~190 chars
      assert.ok(phrase.length > 150, "fixture must exceed the probe length");
      const [hit] = locateInPdf(phrase, long);
      assert.ok(hit, "a long phrase still anchors");
      assert.strictEqual(hit.score, 1);
      assert.strictEqual(hit.quadPoints.length, 24, "all three lines covered");
    });

    it("still anchors when only the opening survives on this page", () => {
      const runsOff =
        long.pages[0].norm + " and then a continuation that is on the next page";
      const [hit] = locateInPdf(runsOff, long);
      assert.ok(hit, "the part that is present still anchors the mark");
      assert.strictEqual(hit.score, 1);
    });
  });
});
