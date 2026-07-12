import * as assert from "node:assert";
import {
  buildSourceIndex,
  matchAnchor,
  topMatches,
} from "../matching/fuzzyMatch.js";

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

  it("isolates a sentence that starts mid-line", () => {
    // The highlighted phrase begins partway through the source line and the
    // line carries extra words before/after it — the token-window scorer should
    // still land the phrase with a high score rather than being diluted.
    const src = buildSourceIndex(
      "Editor note: the quick brown fox jumps over the lazy dog again."
    );
    const m = matchAnchor("the quick brown fox jumps over the lazy dog", src);
    assert.ok(m, "expected a match");
    assert.strictEqual(m!.startLine, 0);
    assert.ok(m!.score > 0.75, `score ${m!.score}`);
  });

  it("matches a phrase that wraps across two source lines", () => {
    const m = matchAnchor(
      "wish to describe a concept or an event",
      idx
    );
    assert.ok(m, "expected a match");
    assert.strictEqual(m!.startLine, 4);
    assert.strictEqual(m!.endLine, 5);
    assert.ok(m!.score > 0.7, `score ${m!.score}`);
  });
});

describe("topMatches", () => {
  const idx = buildSourceIndex(SOURCE);

  it("ranks the true source line first", () => {
    const cands = topMatches(
      "An entity is any distinct thing we wish to describe",
      idx,
      5
    );
    assert.ok(cands.length > 0, "expected candidates");
    assert.strictEqual(cands[0].startLine, 4);
  });

  it("returns candidates in descending score order, capped at k", () => {
    const cands = topMatches("entity relationship", idx, 3);
    assert.ok(cands.length <= 3, `got ${cands.length}`);
    for (let i = 1; i < cands.length; i++) {
      assert.ok(
        cands[i - 1].score >= cands[i].score,
        `not sorted at ${i}: ${cands[i - 1].score} < ${cands[i].score}`
      );
    }
  });

  it("dedupes by start line — one candidate per source line", () => {
    const cands = topMatches("entity", idx, 10);
    const starts = cands.map((c) => c.startLine);
    assert.strictEqual(
      new Set(starts).size,
      starts.length,
      "duplicate start lines in candidate list"
    );
  });

  it("returns nothing for empty anchors or k <= 0", () => {
    assert.deepStrictEqual(topMatches("", idx, 5), []);
    assert.deepStrictEqual(topMatches("entity", idx, 0), []);
  });

  it("surfaces a below-threshold line matchAnchor would still pick", () => {
    // Weak overlap: topMatches must still offer the best-effort line so the
    // triage flow has something to propose even when auto-mapping declines it.
    const cands = topMatches("relationship connects entities", idx, 5);
    assert.ok(cands.length > 0);
    assert.strictEqual(cands[0].startLine, 7);
  });
});
