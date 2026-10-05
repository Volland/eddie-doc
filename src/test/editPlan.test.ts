import * as assert from "node:assert";
import {
  applyEdits,
  availableActions,
  overlaps,
  parseSuggestion,
  planAllConfident,
  planDeleteLines,
  planDeleteStruck,
  planInsertAtMark,
  planInsertNote,
  planReplaceMarked,
} from "../core/edits/plan.js";
import type { ReviewItem } from "../core/model/types.js";

const SRC = "= Title\n\nThe quick brown fox jumps over the lazy dog.\nSecond line here.\n";

function item(over: Partial<ReviewItem>): ReviewItem {
  return {
    id: "a",
    kind: "strikeout",
    page: 1,
    comment: "",
    anchoredText: "",
    rect: [0, 0, 1, 1],
    match: { startLine: 2, endLine: 2, score: 1, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

// @lat: [[tests#Edits#Edit planning]]
describe("edit planning", () => {
  it("deletes exactly the struck words and one neighbouring space", () => {
    const e = planDeleteStruck(SRC, item({ markedText: "brown fox" }))!;
    assert.strictEqual(
      applyEdits(SRC, [e]),
      "= Title\n\nThe quick jumps over the lazy dog.\nSecond line here.\n"
    );
  });

  it("replaces the marked text in place", () => {
    const e = planReplaceMarked(SRC, item({ kind: "highlight", markedText: "lazy dog" }), "sleepy cat")!;
    assert.ok(applyEdits(SRC, [e]).includes("over the sleepy cat."));
  });

  it("inserts just after the text left of a caret mark", () => {
    const e = planInsertAtMark(SRC, item({ kind: "insert", beforeText: "The quick" }), " very")!;
    assert.ok(applyEdits(SRC, [e]).includes("The quick very brown"));
  });

  it("falls back to the end of the line when nothing precedes the caret", () => {
    const e = planInsertAtMark(SRC, item({ kind: "insert" }), "!")!;
    assert.ok(applyEdits(SRC, [e]).includes("lazy dog.!\n"));
  });

  it("deletes whole lines including the last, with no trailing newline to take", () => {
    const e = planDeleteLines(SRC, item({ match: { startLine: 3, endLine: 3, score: 1, sourceExcerpt: "" } }))!;
    assert.strictEqual(applyEdits(SRC, [e]), "= Title\n\nThe quick brown fox jumps over the lazy dog.\n");
    const last = "a\nb";
    const e2 = planDeleteLines(last, item({ match: { startLine: 1, endLine: 1, score: 1, sourceExcerpt: "" } }))!;
    assert.strictEqual(applyEdits(last, [e2]), "a\n");
  });

  it("inserts the editor's note as a comment line, keeping indentation and CRLF", () => {
    const crlf = "= T\r\n\r\n  indented line\r\n";
    const e = planInsertNote(
      crlf,
      item({ kind: "comment", comment: "Reword\nthis", author: "Rachel", match: { startLine: 2, endLine: 2, score: 1, sourceExcerpt: "" } })
    )!;
    assert.strictEqual(
      applyEdits(crlf, [e]),
      "= T\r\n\r\n  // ✎ Comment — Rachel: Reword this\r\n  indented line\r\n"
    );
  });

  it("plans nothing for an unplaced or out-of-range annotation", () => {
    const un = item({ match: undefined, markedText: "fox" });
    assert.strictEqual(planDeleteStruck(SRC, un), null);
    assert.strictEqual(planDeleteLines(SRC, un), null);
    assert.strictEqual(planDeleteStruck(SRC, item({ markedText: "no such words", })), null);
    assert.deepStrictEqual(availableActions(un, false), []);
  });

  it("offers actions by kind", () => {
    const names = (i: ReviewItem) => availableActions(i, true).map((a) => a.action);
    assert.deepStrictEqual(names(item({})), ["delete-struck", "replace-marked", "delete-lines"]);
    assert.deepStrictEqual(names(item({ kind: "highlight", comment: "x" })), ["replace-marked", "insert-note"]);
    assert.deepStrictEqual(names(item({ kind: "highlight" })), []);
    assert.deepStrictEqual(names(item({ kind: "insert" })), ["insert-at-mark"]);
  });

  it("parses a suggestion from quotes or after a directive", () => {
    assert.strictEqual(parseSuggestion("Reword: 'trust or lineage'."), "trust or lineage");
    assert.strictEqual(parseSuggestion("Replace with - the lazy hound"), "the lazy hound");
    assert.strictEqual(parseSuggestion("  Use   plain  words "), "plain words");
    assert.strictEqual(parseSuggestion("Looks odd"), "Looks odd");
  });

  it("plans every confident edit, skipping what needs a human", () => {
    const items = [
      item({ id: "s", kind: "strikeout", markedText: "quick brown" }),
      item({ id: "h", kind: "highlight", comment: "Reword: 'sleepy cat'", markedText: "lazy dog" }),
      item({ id: "hn", kind: "highlight", comment: "", markedText: "fox" }), // no suggestion
      item({ id: "done", kind: "strikeout", markedText: "jumps", resolved: true }),
      item({ id: "weak", kind: "strikeout", markedText: "over" }),
      item({ id: "lost", kind: "strikeout", markedText: "absent words" }),
    ];
    const plan = planAllConfident(SRC, items, (i) => i.id !== "weak");
    assert.deepStrictEqual(plan.map((p) => p.id), ["s", "h"]);
    assert.strictEqual(overlaps(plan.map((p) => p.edit)), false);
    assert.strictEqual(
      applyEdits(SRC, plan.map((p) => p.edit)),
      // Bulk deletion takes the exact range, as VS Code's "apply all" does: the
      // single-edit space cleanup could make neighbours claim the same space.
      "= Title\n\nThe  fox jumps over the sleepy cat.\nSecond line here.\n"
    );
  });

  it("detects edits that would collide", () => {
    assert.strictEqual(overlaps([{ from: 0, to: 5, insert: "" }, { from: 3, to: 8, insert: "" }]), true);
    assert.strictEqual(overlaps([{ from: 0, to: 5, insert: "" }, { from: 5, to: 8, insert: "" }]), false);
    assert.strictEqual(overlaps([{ from: 4, to: 4, insert: "a" }, { from: 4, to: 4, insert: "b" }]), true);
  });
});
