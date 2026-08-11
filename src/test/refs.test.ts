/**
 * Editor reference numbers.
 *
 * The pattern has to be greedy enough to catch how copyeditors really number
 * queries, and narrow enough that a comment quoting AsciiDoc — `[source,ruby]`,
 * `[#anchor]` — never gets one of those promoted to a heading.
 */
import * as assert from "node:assert";
import { commentRef, refPrefix, withoutRef } from "../model/refs.js";
import type { ReviewItem } from "../model/types.js";

describe("commentRef", () => {
  it("finds a reference wherever the editor put it", () => {
    assert.strictEqual(commentRef("[12] Please check this citation."), "[12]");
    assert.strictEqual(commentRef("Please check this citation. [12]"), "[12]");
    assert.strictEqual(commentRef("AU: reword — see [7] in my notes"), "[7]");
  });

  it("takes the shapes editors actually use", () => {
    assert.strictEqual(commentRef("[C12] tighten"), "[C12]");
    assert.strictEqual(commentRef("[AU 3] query"), "[AU3]");
    assert.strictEqual(commentRef("[12a] second half"), "[12a]");
    assert.strictEqual(commentRef("[12–14] these three"), "[12–14]");
    assert.strictEqual(commentRef("[ 8 ] padded"), "[8]");
    assert.strictEqual(commentRef("[#4] hash"), "[#4]");
  });

  it("ignores brackets that are not references", () => {
    // A comment quoting markup must not have it hoisted into a heading.
    for (const text of [
      "use [source,ruby] here",
      "give it an id like [#chapter-anatomy]",
      "[quote] this as a blockquote",
      "cite [Pavlyshyn] properly",
      "no brackets at all",
      "",
    ]) {
      assert.strictEqual(commentRef(text), undefined, text);
    }
  });

  it("has nothing to say about a missing comment", () => {
    assert.strictEqual(commentRef(undefined), undefined);
  });
});

describe("withoutRef", () => {
  it("removes the reference and the punctuation that trailed it", () => {
    assert.strictEqual(withoutRef("[12] Please check this."), "Please check this.");
    assert.strictEqual(withoutRef("[12]: Please check this."), "Please check this.");
    assert.strictEqual(withoutRef("[12] - Please check this."), "Please check this.");
    assert.strictEqual(withoutRef("Please check this. [12]"), "Please check this.");
  });

  it("leaves a comment with no reference exactly as it was", () => {
    assert.strictEqual(withoutRef("Tighten this."), "Tighten this.");
    assert.strictEqual(withoutRef("use [source,ruby]"), "use [source,ruby]");
  });

  it("keeps the comment when the reference was all of it", () => {
    // "[12]" alone is still the whole remark; blanking it would lose the item.
    assert.strictEqual(withoutRef("[12]"), "[12]");
  });
});

describe("refPrefix", () => {
  function item(comment: string): ReviewItem {
    return {
      id: "i",
      kind: "highlight",
      page: 1,
      comment,
      anchoredText: "",
      rect: [0, 0, 0, 0],
      match: null,
      resolved: false,
    } as ReviewItem;
  }

  it("is ready to concatenate, or empty", () => {
    assert.strictEqual(refPrefix(item("[12] check")), "[12] ");
    assert.strictEqual(refPrefix(item("check")), "");
  });
});
