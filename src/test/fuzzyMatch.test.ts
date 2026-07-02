import * as assert from "node:assert";
import { buildSourceIndex, matchAnchor } from "../matching/fuzzyMatch.js";

const SOURCE = [
  "= Chapter One", // 0
  "", // 1
  "== Entities and Relationships", // 2
  "", // 3
  "An *entity* is any distinct thing we wish to describe: a person, a place,", // 4
  "a concept, or an event. Each entity is given a stable identifier.", // 5
  "", // 6
  "A relationship connects two entities and carries its own meaning.", // 7
].join("\n");

describe("matchAnchor", () => {
  const idx = buildSourceIndex(SOURCE);

  it("maps highlighted prose (markup-free) to the right source line", () => {
    // Text as it would appear extracted from a PDF (no AsciiDoc markup).
    const m = matchAnchor(
      "An entity is any distinct thing we wish to describe",
      idx
    );
    assert.ok(m, "expected a match");
    assert.strictEqual(m!.startLine, 4);
    assert.ok(m!.score > 0.6, `score ${m!.score}`);
  });

  it("matches a phrase from a different line independently", () => {
    const m = matchAnchor(
      "A relationship connects two entities and carries its own meaning",
      idx
    );
    assert.ok(m);
    assert.strictEqual(m!.startLine, 7);
    assert.ok(m!.score > 0.8);
  });

  it("returns null for empty/punctuation-only anchors", () => {
    assert.strictEqual(matchAnchor("", idx), null);
    assert.strictEqual(matchAnchor("   .,;  ", idx), null);
  });

  it("gives a low score to unrelated text", () => {
    const m = matchAnchor("quarterly revenue projections spreadsheet", idx);
    // May still return a best-effort span, but it must score poorly.
    assert.ok(!m || m.score < 0.3, `unexpected score ${m?.score}`);
  });
});
