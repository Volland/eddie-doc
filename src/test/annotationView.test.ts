import * as assert from "node:assert";
import {
  applyFilter,
  bucketOf,
  countBuckets,
  groupItems,
  itemSpan,
  itemTitle,
} from "../core/view/annotationView.js";
import type { ReviewItem } from "../core/model/types.js";

function it_(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "comment",
    page: 1,
    comment: `c-${id}`,
    anchoredText: "",
    rect: [0, 0, 1, 1],
    match: { startLine: 1, endLine: 1, score: 0.9, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

// @lat: [[tests#Annotation view#Classification and filtering]]
describe("annotation view", () => {
  const items = [
    it_("open"),
    it_("weak", { match: { startLine: 4, endLine: 4, score: 0.55, sourceExcerpt: "" } }),
    it_("none", { match: undefined }),
    it_("done", { resolved: true }),
    it_("hand", { match: undefined, manualLine: 7 }),
  ];

  it("buckets by resolution, placement and confidence", () => {
    const b = Object.fromEntries(items.map((i) => [i.id, bucketOf(i, 0.75)]));
    assert.deepStrictEqual(b, {
      open: "open",
      weak: "review",
      none: "unmatched",
      done: "resolved",
      hand: "open", // a hand-placed link is trusted
    });
  });

  it("counts and groups in display order, omitting empty groups", () => {
    assert.deepStrictEqual(countBuckets(items, 0.75), {
      open: 2, review: 1, unmatched: 1, resolved: 1, total: 5,
    });
    assert.deepStrictEqual(
      groupItems(items, 0.75).map((g) => g.label),
      ["Open (2)", "Needs review (1)", "Unmatched (1)", "Resolved (1)"]
    );
    assert.deepStrictEqual(groupItems([it_("x")], 0.75).map((g) => g.bucket), ["open"]);
  });

  it("filters by bucket, kind, page, text and the resolved toggle", () => {
    const ids = (f: Parameters<typeof applyFilter>[1]) =>
      applyFilter(items, f, 0.75).map((i) => i.id);
    assert.deepStrictEqual(ids({ hideResolved: true }), ["open", "weak", "none", "hand"]);
    assert.deepStrictEqual(ids({ buckets: ["unmatched", "review"] }), ["weak", "none"]);
    assert.deepStrictEqual(ids({ text: "C-WEAK" }), ["weak"]);
    assert.deepStrictEqual(ids({ page: 2 }), []);
    assert.deepStrictEqual(ids({ kinds: ["highlight"] }), []);
  });

  it("titles with the remark number and clips long text", () => {
    assert.strictEqual(itemTitle(it_("n", { number: 3, comment: "Fix this" })), "#3 Fix this");
    assert.ok(itemTitle(it_("n", { comment: "x".repeat(200) })).endsWith("…"));
  });

  it("spans a block of lines, or one line for a hand-placed link", () => {
    assert.deepStrictEqual(
      itemSpan(it_("a", { match: { startLine: 2, endLine: 5, score: 1, sourceExcerpt: "" } })),
      { start: 2, end: 5 }
    );
    assert.deepStrictEqual(itemSpan(it_("h", { match: undefined, manualLine: 7 })), { start: 7, end: 7 });
    assert.strictEqual(itemSpan(it_("u", { match: undefined })), null);
  });
});
