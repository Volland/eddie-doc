import * as assert from "node:assert";
import {
  shiftLine,
  countNewlines,
  type ContentChange,
} from "../matching/posTrack.js";

/** A single-line insertion of `n` blank lines above `atLine`. */
function insertLines(atLine: number, n: number): ContentChange {
  return { startLine: atLine, endLine: atLine, newLineCount: n };
}

/** Deletion of whole lines [from, to) (to exclusive). */
function deleteLines(from: number, to: number): ContentChange {
  return { startLine: from, endLine: to, newLineCount: 0 };
}

describe("countNewlines", () => {
  it("counts newlines in inserted text", () => {
    assert.strictEqual(countNewlines("abc"), 0);
    assert.strictEqual(countNewlines("a\nb"), 1);
    assert.strictEqual(countNewlines("\n\n\n"), 3);
  });
});

describe("shiftLine", () => {
  it("pushes anchors below an insertion down", () => {
    const ch = [insertLines(2, 3)]; // 3 lines added starting at line 2
    assert.strictEqual(shiftLine(10, ch), 13);
    assert.strictEqual(shiftLine(5, ch), 8);
  });

  it("leaves anchors above an insertion untouched", () => {
    const ch = [insertLines(5, 2)];
    assert.strictEqual(shiftLine(1, ch), 1);
    assert.strictEqual(shiftLine(5, ch), 5); // the edit's own start line stays
  });

  it("pulls anchors below a deletion up", () => {
    const ch = [deleteLines(3, 6)]; // remove 3 lines
    assert.strictEqual(shiftLine(10, ch), 7);
  });

  it("collapses an anchor that sat inside deleted text", () => {
    const ch = [deleteLines(3, 6)];
    // Lines 4 and 5 are gone; they collapse to the deletion start.
    assert.strictEqual(shiftLine(4, ch), 3);
    assert.strictEqual(shiftLine(5, ch), 3);
  });

  it("never returns a negative line", () => {
    assert.strictEqual(shiftLine(1, [deleteLines(0, 5)]), 0);
  });

  it("accumulates multiple changes (given in reverse doc order)", () => {
    // VS Code orders changes bottom-to-top: delete near line 20, insert near 2.
    const changes = [deleteLines(20, 22), insertLines(2, 1)];
    // Anchor at 30: -2 (deletion) +1 (insertion) = 29.
    assert.strictEqual(shiftLine(30, changes), 29);
    // Anchor at 10: only the insertion above it applies (+1).
    assert.strictEqual(shiftLine(10, changes), 11);
  });
});
