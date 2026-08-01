import * as assert from "node:assert";
import { renderReport } from "../model/report.js";
import type { ReviewItem, ReviewSession } from "../model/types.js";

function item(id: string, over: Partial<ReviewItem>): ReviewItem {
  return {
    id,
    kind: "highlight",
    page: 1,
    comment: "",
    anchoredText: "",
    rect: [0, 0, 0, 0],
    match: null,
    resolved: false,
    ...over,
  };
}

function session(items: ReviewItem[]): ReviewSession {
  return {
    version: 2,
    adocPath: "/book/chapter-01.adoc",
    pdfPath: "/book/chapter-01.annotated.pdf",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    items,
  };
}

const ITEMS: ReviewItem[] = [
  item("open", {
    kind: "strikeout",
    comment: "Cut — repeats the intro.",
    markedText: "entities are stable and reusable",
    match: { startLine: 34, endLine: 34, score: 0.9, sourceExcerpt: "Knowledge graphs put…" },
  }),
  item("review", {
    comment: "Reword this.",
    match: { startLine: 10, endLine: 10, score: 0.6, sourceExcerpt: "We will move…", method: "lexical" },
  }),
  item("lost", { comment: "Where does this go?", anchoredText: "mystery words" }),
  item("done", {
    comment: "Strong framing — keep this.",
    match: { startLine: 7, endLine: 7, score: 0.88, sourceExcerpt: "graph places…" },
    resolved: true,
    note: "kept as-is",
  }),
];

describe("renderReport", () => {
  it("groups items into the four review sections with counts", () => {
    const md = renderReport(session(ITEMS), { highConfidence: 0.75 });
    assert.ok(md.startsWith("# Review report — chapter-01.adoc"));
    assert.ok(md.includes("## Open (1)"));
    assert.ok(md.includes("## Needs review (1)"));
    assert.ok(md.includes("## Unmatched (1)"));
    assert.ok(md.includes("## Resolved (1)"));
    assert.ok(md.includes("1 of 4 resolved · 1 open · 1 need review · 1 unmatched"));
  });

  it("renders locations, methods, comments and notes", () => {
    const md = renderReport(session(ITEMS), { highConfidence: 0.75 });
    assert.ok(md.includes("line 35 · 0.90"), "1-based line with score");
    assert.ok(md.includes("lexical 0.60"), "non-fuzzy method is labeled");
    assert.ok(md.includes("> Cut — repeats the intro."));
    assert.ok(md.includes("marked: “entities are stable and reusable”"));
    assert.ok(md.includes("note: kept as-is"));
    assert.ok(md.includes("no source match"));
  });

  it("omits the resolved section when asked", () => {
    const md = renderReport(session(ITEMS), { includeResolved: false });
    assert.ok(!md.includes("## Resolved"));
  });

  it("omits empty sections entirely", () => {
    const md = renderReport(session([ITEMS[0]]));
    assert.ok(md.includes("## Open (1)"));
    assert.ok(!md.includes("## Unmatched"));
    assert.ok(!md.includes("## Resolved"));
  });

  it("warns when inputs are stale", () => {
    const md = renderReport(session(ITEMS), { stale: true });
    assert.ok(md.includes("⚠️"));
    assert.ok(md.includes("Re-map Annotations"));
  });

  it("treats manual links as confident and labels them", () => {
    const manual = item("m", { comment: "Hand-placed.", manualLine: 3 });
    const md = renderReport(session([manual]));
    assert.ok(md.includes("## Open (1)"));
    assert.ok(md.includes("line 4 · manual"));
  });
});
