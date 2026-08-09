import * as assert from "node:assert";
import type { PageText, PositionedText } from "../pdf/extract.js";
import { anchorItems } from "../pdf/anchor.js";
import type { ReviewItem } from "../model/types.js";

/** A page of rendered lines, as asciidoctor-pdf emits them. */
function page(n: number, lines: string[]): PageText {
  const texts: PositionedText[] = lines.map((str, i) => ({
    str,
    box: { x0: 50, x1: 50 + str.length * 5, y0: 700 - i * 14, y1: 710 - i * 14 },
  }));
  return { page: n, height: 792, width: 612, texts };
}

/**
 * The source, and the PDF rendered from it. They agree, because the PDF was
 * built from this exact text — that is the whole premise of the export
 * direction.
 */
const SOURCE = [
  "= Anatomy", // 0
  "", // 1
  "Two debts come into play here: naming and scope. Chapter 2 designed a", // 2
  "memory system in the abstract, governed by a control executive.", // 3
  "", // 4
  "[#ch04-figure-anatomy]", // 5
  "image::anatomy.png[]", // 6
  "", // 7
  "Entities are stable and reusable across the graph.", // 8
].join("\n");

const PAGES = [
  page(1, [
    "Two debts come into play here: naming and scope. Chapter 2 designed a",
    "memory system in the abstract, governed by a control executive.",
    "Entities are stable and reusable across the graph.",
  ]),
];

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "p1-highlight-1-1",
    kind: "highlight",
    page: 1,
    comment: "",
    anchoredText: "",
    rect: [0, 0, 0, 0],
    match: { startLine: 2, endLine: 3, score: 1, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

describe("anchorItems", () => {
  it("places an item on the paragraph its source lines render to", () => {
    const { anchored, unstamped } = anchorItems([item()], SOURCE, PAGES);
    assert.strictEqual(unstamped.length, 0);
    assert.strictEqual(anchored.length, 1);
    assert.strictEqual(anchored[0].hit.page, 1);
    assert.strictEqual(anchored[0].hit.score, 1);
    // The paragraph wraps two rendered lines, so two quads.
    assert.strictEqual(anchored[0].hit.quadPoints.length, 16);
  });

  it("narrows to the editor's marked words when they survived the rewrite", () => {
    const withMark = item({
      kind: "strikeout",
      markedText: "governed by a control executive",
    });
    const [a] = anchorItems([withMark], SOURCE, PAGES).anchored;
    assert.strictEqual(a.precision, "exact");
    // Tighter than the whole paragraph.
    const whole = anchorItems([item()], SOURCE, PAGES).anchored[0];
    assert.ok(a.hit.rect[2] - a.hit.rect[0] < whole.hit.rect[2] - whole.hit.rect[0]);
  });

  it("degrades to the paragraph when the marked words were rewritten away", () => {
    // What the editor struck no longer appears anywhere in the source.
    const stale = item({
      kind: "strikeout",
      markedText: "and it is worth naming them up front because much of this",
    });
    const [a] = anchorItems([stale], SOURCE, PAGES).anchored;
    assert.strictEqual(a.precision, "line");
    assert.strictEqual(a.hit.score, 1, "the paragraph itself is still exact");
  });

  it("ignores the stored PDF geometry entirely", () => {
    // Geometry from a PDF that no longer exists: wrong page, wrong coordinates.
    const stale = item({ page: 27, rect: [999, 999, 1000, 1000] });
    const [a] = anchorItems([stale], SOURCE, PAGES).anchored;
    assert.strictEqual(a.hit.page, 1);
    assert.ok(a.hit.rect[0] < 600);
  });

  it("reports an unmatched item instead of guessing a position", () => {
    const orphan = item({ match: null });
    const { anchored, unstamped } = anchorItems([orphan], SOURCE, PAGES);
    assert.strictEqual(anchored.length, 0);
    assert.strictEqual(unstamped.length, 1);
    assert.match(unstamped[0].reason, /no source location/);
  });

  it("reports text that is not in the render rather than placing it loosely", () => {
    const ghost = item({
      match: { startLine: 8, endLine: 8, score: 1, sourceExcerpt: "" },
    });
    const emptyPages = [page(1, ["Nothing here resembles the source at all."])];
    const { anchored, unstamped } = anchorItems([ghost], SOURCE, emptyPages);
    assert.strictEqual(anchored.length, 0);
    assert.strictEqual(unstamped.length, 1);
    assert.match(unstamped[0].reason, /not found in the rendered PDF/);
  });

  it("places a figure through its named destination when one exists", () => {
    const fig = item({
      kind: "comment",
      // The image macro is not prose, so there is nothing to search for.
      match: { startLine: 6, endLine: 6, score: 1, sourceExcerpt: "" },
      anchor: { blockId: "ch04-figure-anatomy" },
    });
    const dests = new Map([["ch04-figure-anatomy", { page: 1, y: 400 }]]);
    const [a] = anchorItems([fig], SOURCE, PAGES, { destinations: dests }).anchored;
    assert.strictEqual(a.precision, "block");
    assert.strictEqual(a.hit.page, 1);
    assert.ok(a.hit.rect[3] <= 400 && a.hit.rect[1] < 400);
  });

  it("returns items in document order", () => {
    const first = item({
      id: "a",
      match: { startLine: 8, endLine: 8, score: 1, sourceExcerpt: "" },
    });
    const second = item({
      id: "b",
      match: { startLine: 2, endLine: 2, score: 1, sourceExcerpt: "" },
    });
    const { anchored } = anchorItems([first, second], SOURCE, PAGES);
    // "b" renders above "a" on the page, so it comes first.
    assert.deepStrictEqual(
      anchored.map((x) => x.item.id),
      ["b", "a"]
    );
  });

  it("honours a manual re-link over the stored match", () => {
    const relinked = item({
      match: { startLine: 2, endLine: 3, score: 0.2, sourceExcerpt: "" },
      manualLine: 8,
    });
    const [a] = anchorItems([relinked], SOURCE, PAGES).anchored;
    // Line 8 renders as the third line on the page, near the bottom.
    assert.ok(a.hit.rect[1] < 690);
    assert.strictEqual(a.hit.quadPoints.length, 8, "one line -> one quad");
  });
});
