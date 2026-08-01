import * as assert from "node:assert";
import { charGrams, lexicalFallback } from "../matching/lexical.js";
import type { ReviewItem } from "../model/types.js";

const SOURCE = [
  "= Doc", // 0
  "", // 1
  "The reification of statements enables provenance tracking across the graph.", // 2
  "", // 3
  "Entities are stable identifiers for people, places, and concepts.", // 4
].join("\n");

function item(anchoredText: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "x",
    kind: "highlight",
    page: 1,
    comment: "",
    anchoredText,
    rect: [0, 0, 0, 0],
    match: null,
    resolved: false,
    ...over,
  };
}

describe("charGrams", () => {
  it("is insensitive to case, punctuation and extra whitespace", () => {
    assert.deepStrictEqual(
      charGrams("Knowledge   Graphs!"),
      charGrams("knowledge graphs")
    );
  });
});

describe("lexicalFallback", () => {
  it("rescues inflected wording that shares trigrams with a paragraph", () => {
    const it1 = item("reifying statement enable provenance tracked");
    const applied = lexicalFallback([it1], SOURCE, 0.45);
    assert.strictEqual(applied, 1);
    assert.strictEqual(it1.match?.method, "lexical");
    assert.strictEqual(it1.match?.startLine, 2);
    assert.strictEqual(it1.match?.endLine, 2);
  });

  it("leaves genuinely unrelated anchors unmatched", () => {
    const it1 = item("quantum cheeseburger nebula flavor");
    const applied = lexicalFallback([it1], SOURCE, 0.45);
    assert.strictEqual(applied, 0);
    assert.strictEqual(it1.match, null);
  });

  it("ignores anchors too short to place responsibly", () => {
    const it1 = item("the");
    const applied = lexicalFallback([it1], SOURCE, 0.1);
    assert.strictEqual(applied, 0);
  });

  it("skips items that are already matched or manually linked", () => {
    const matched = item("reification of statements", {
      match: { startLine: 2, endLine: 2, score: 1, sourceExcerpt: "x" },
    });
    const manual = item("reification of statements", { manualLine: 4 });
    const applied = lexicalFallback([matched, manual], SOURCE, 0.1);
    assert.strictEqual(applied, 0);
    assert.strictEqual(manual.match, null);
  });
});
