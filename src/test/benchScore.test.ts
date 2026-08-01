import * as assert from "node:assert";
import { scoreItems, type GoldenCase } from "../benchmark/score.js";
import type { ReviewItem } from "../model/types.js";

function item(comment: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: comment,
    kind: "highlight",
    page: 1,
    comment,
    anchoredText: "",
    rect: [0, 0, 0, 0],
    match: null,
    resolved: false,
    ...over,
  };
}

const ITEMS: ReviewItem[] = [
  item("Cut this.", {
    match: { startLine: 34, endLine: 35, score: 0.9, sourceExcerpt: "x" },
  }),
  item("Reword that.", {
    match: { startLine: 2, endLine: 2, score: 0.8, sourceExcerpt: "x" },
  }),
  item("Couldn't place me."),
  item("", { anchoredText: "anchored only words" }),
];

describe("scoreItems", () => {
  it("scores overlap with the expected 1-based region as correct", () => {
    const cases: GoldenCase[] = [{ key: "Cut this.", lines: [35, 35] }];
    const s = scoreItems(ITEMS, cases);
    assert.strictEqual(s.correct, 1);
    assert.strictEqual(s.results[0].status, "correct");
  });

  it("flags mapped-but-elsewhere as wrong-line", () => {
    const s = scoreItems(ITEMS, [{ key: "Reword that.", lines: [10, 12] }]);
    assert.strictEqual(s.results[0].status, "wrong-line");
    assert.strictEqual(s.failed, 1);
  });

  it("flags expected-location-but-unmatched as missed", () => {
    const s = scoreItems(ITEMS, [{ key: "Couldn't place me.", lines: [1, 1] }]);
    assert.strictEqual(s.results[0].status, "missed");
  });

  it("supports expectUnmatched both ways", () => {
    const s = scoreItems(ITEMS, [
      { key: "Couldn't place me.", expectUnmatched: true },
      { key: "Cut this.", expectUnmatched: true },
    ]);
    assert.strictEqual(s.results[0].status, "correct");
    assert.strictEqual(s.results[1].status, "unexpected-match");
  });

  it("falls back to anchored text for keys and reports unknown keys", () => {
    const s = scoreItems(ITEMS, [
      { key: "anchored only", lines: [1, 1] },
      { key: "never annotated", lines: [1, 1] },
    ]);
    assert.strictEqual(s.results[0].status, "missed"); // found via anchoredText
    assert.strictEqual(s.results[1].status, "annotation-missing");
  });

  it("rejects a case with neither lines nor expectUnmatched", () => {
    assert.throws(() => scoreItems(ITEMS, [{ key: "Cut this." }]));
  });
});
