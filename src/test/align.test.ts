import * as assert from "node:assert";
import { normalizeWithMap, locate } from "../matching/align.js";

describe("normalizeWithMap", () => {
  it("maps each normalized char back to its raw offset", () => {
    const raw = "An *entity* node";
    const { norm, map } = normalizeWithMap(raw);
    assert.strictEqual(norm, "an entity node");
    // 'e' of "entity" in norm should map to the 'e' in raw (after "An *").
    const eNorm = norm.indexOf("entity");
    assert.strictEqual(raw[map[eNorm]], "e");
  });

  it("collapses runs of markup/space to a single separator", () => {
    const { norm } = normalizeWithMap("a  --  b");
    assert.strictEqual(norm, "a b");
  });

  it("trims leading and trailing non-word characters", () => {
    const { norm } = normalizeWithMap("  *hello*  ");
    assert.strictEqual(norm, "hello");
  });
});

describe("locate", () => {
  it("finds struck words inside markup and returns exact raw offsets", () => {
    const raw = "We move from simple triples to *richer metagraph structures*.";
    const hit = locate("richer metagraph structures", raw);
    assert.ok(hit, "expected a hit");
    assert.strictEqual(hit!.score, 1);
    assert.strictEqual(raw.slice(hit!.start, hit!.end), "richer metagraph structures");
  });

  it("locates text even when the source wraps across a newline", () => {
    const raw = "A relationship connects two\nentities and carries meaning.";
    const hit = locate("connects two entities and", raw);
    assert.ok(hit);
    // Range spans the newline; normalized content matches.
    const got = raw.slice(hit!.start, hit!.end).replace(/\s+/g, " ");
    assert.strictEqual(got, "connects two entities and");
  });

  it("returns a precise sub-range, not the whole line", () => {
    const raw = "Reification lets us attach a confidence score to a fact.";
    const hit = locate("confidence score", raw);
    assert.ok(hit);
    assert.strictEqual(raw.slice(hit!.start, hit!.end), "confidence score");
  });

  it("tolerates a small substitution via the fuzzy fallback", () => {
    // Same length, one substituted char (e.g. an OCR slip brown->brawn).
    const raw = "the quick brown fox jumps";
    const hit = locate("quick brawn fox", raw, 0.7);
    assert.ok(hit, "expected fuzzy hit");
    assert.ok(hit!.score < 1, "should not be an exact match");
    assert.ok(raw.slice(hit!.start, hit!.end).includes("brown"));
  });

  it("refuses an indel-heavy match rather than guess (conservative)", () => {
    // An inserted char shifts alignment; positional similarity stays low, so we
    // decline instead of deleting the wrong characters.
    const raw = "the quick brown fox jumps";
    assert.strictEqual(locate("quick browne fox", raw, 0.8), null);
  });

  it("returns null when nothing matches", () => {
    assert.strictEqual(locate("xyzzy plugh", "the quick brown fox"), null);
    assert.strictEqual(locate("", "the quick brown fox"), null);
  });
});
