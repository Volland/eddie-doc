import * as assert from "node:assert";
import { normalizeWithMap, locate, locateQuote } from "../core/matching/align.js";

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

describe("locateQuote", () => {
  /** A paragraph that says the same thing twice — which manuscripts do. */
  const BLOCK =
    "The first debt is trust. Chapter 2 promised a memory system and " +
    "deferred the question. The second debt is trust, and it is the harder one.";

  const at = (hit: { start: number; end: number } | null) =>
    hit ? BLOCK.slice(hit.start, hit.end) : null;

  it("picks the occurrence its context points at, not the first", () => {
    const second = locateQuote(
      { exact: "is trust", prefix: "The second debt ", suffix: ", and it is the harder" },
      BLOCK
    );
    assert.strictEqual(at(second), "is trust");
    assert.strictEqual(second!.method, "quote");
    // Proof it is the SECOND one: the first lies in the opening sentence.
    assert.ok(second!.start > BLOCK.indexOf("Chapter 2"));
  });

  it("distinguishes the two occurrences by context alone", () => {
    const first = locateQuote({ exact: "is trust", prefix: "The first debt " }, BLOCK);
    const second = locateQuote({ exact: "is trust", prefix: "The second debt " }, BLOCK);
    assert.notStrictEqual(first!.start, second!.start);
    assert.ok(first!.start < second!.start);
  });

  it("falls back to the span when the context around it was rewritten", () => {
    const hit = locateQuote(
      {
        exact: "deferred the question",
        prefix: "and completely different words that are no longer present ",
        suffix: " nor are these",
      },
      BLOCK
    );
    assert.strictEqual(at(hit), "deferred the question");
    // Says so, rather than claiming the context still matched.
    assert.strictEqual(hit!.method, "exact");
  });

  it("reads through AsciiDoc markup in the source", () => {
    const marked = "The second debt is *trust*, and it is the harder one.";
    const hit = locateQuote({ exact: "is trust", prefix: "The second debt " }, marked);
    assert.ok(hit);
    assert.ok(marked.slice(hit!.start, hit!.end).includes("trust"));
  });

  it("gives up when the words themselves are gone", () => {
    assert.strictEqual(
      locateQuote({ exact: "a sentence that was deleted outright", prefix: "The first debt " }, BLOCK),
      null
    );
  });

  it("needs an exact span to look for", () => {
    assert.strictEqual(locateQuote({ exact: "", prefix: "The first" }, BLOCK), null);
    assert.strictEqual(locateQuote({ exact: "   " }, BLOCK), null);
  });

  it("works with no context at all", () => {
    const hit = locateQuote({ exact: "Chapter 2 promised" }, BLOCK);
    assert.strictEqual(at(hit), "Chapter 2 promised");
    assert.strictEqual(hit!.method, "exact");
  });
});
