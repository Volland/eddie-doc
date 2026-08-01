import * as assert from "node:assert";
import { mapAnnotations, effectiveLine } from "../matching/mapper.js";
import type { RawAnnotation, ReviewItem } from "../model/types.js";

const SOURCE = [
  "= Doc", // 0
  "", // 1
  "Knowledge graphs put relationships first and entities stay reusable.", // 2
  "", // 3
  "Reification lets us make statements about statements.", // 4
].join("\n");

function ann(id: string, over: Partial<RawAnnotation> = {}): RawAnnotation {
  return {
    id,
    kind: "highlight",
    page: 1,
    comment: "",
    anchoredText: "",
    rect: [0, 0, 0, 0],
    ...over,
  };
}

const UNMATCHED = Number.MAX_SAFE_INTEGER;

describe("mapAnnotations", () => {
  it("links an annotation to its source line above threshold", () => {
    const items = mapAnnotations(
      [ann("a", { anchoredText: "Reification lets us make statements about statements" })],
      SOURCE,
      { threshold: 0.55 }
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(effectiveLine(items[0]), 4);
  });

  it("marks below-threshold matches as unmatched", () => {
    const items = mapAnnotations(
      [ann("a", { anchoredText: "totally unrelated banana content here" })],
      SOURCE,
      { threshold: 0.9 }
    );
    assert.strictEqual(effectiveLine(items[0]), UNMATCHED);
    assert.strictEqual(items[0].match, null);
  });

  it("falls back to the comment when there is no anchored text", () => {
    const items = mapAnnotations(
      [
        ann("a", {
          kind: "comment",
          comment: "Reification lets us make statements about statements",
        }),
      ],
      SOURCE,
      { threshold: 0.55 }
    );
    assert.strictEqual(effectiveLine(items[0]), 4);
  });

  it("preserves resolved state and manual re-link across a re-map", () => {
    const prev: ReviewItem[] = [
      {
        ...ann("a", { anchoredText: "Knowledge graphs put relationships first" }),
        match: null,
        resolved: true,
        manualLine: 2,
      },
    ];
    const items = mapAnnotations(
      [ann("a", { anchoredText: "Knowledge graphs put relationships first" })],
      SOURCE,
      { threshold: 0.55 },
      prev
    );
    assert.strictEqual(items[0].resolved, true);
    assert.strictEqual(items[0].manualLine, 2);
    assert.strictEqual(effectiveLine(items[0]), 2);
  });

  it("carries state to a re-keyed annotation by content fingerprint", () => {
    // Second review round: the editor re-exports the PDF, so every id (derived
    // from page + geometry) changes, but the remark content is identical.
    const prev: ReviewItem[] = [
      {
        ...ann("old-geometry", {
          anchoredText: "Reification lets us make statements about statements",
          comment: "Tighten this.",
          author: "Editor",
        }),
        match: null,
        resolved: true,
        note: "done in draft 2",
      },
    ];
    const stats = { carried: 0 };
    const items = mapAnnotations(
      [
        ann("new-geometry", {
          // Same words modulo whitespace/punctuation — fingerprints match.
          anchoredText: "Reification lets us  make statements about statements.",
          comment: "Tighten this.",
          author: "Editor",
        }),
      ],
      SOURCE,
      { threshold: 0.55 },
      prev,
      stats
    );
    assert.strictEqual(stats.carried, 1);
    assert.strictEqual(items[0].resolved, true);
    assert.strictEqual(items[0].note, "done in draft 2");
  });

  it("does not fingerprint-carry when content differs or ids still match", () => {
    const prev: ReviewItem[] = [
      {
        ...ann("a", { comment: "Tighten this.", anchoredText: "some words" }),
        match: null,
        resolved: true,
      },
    ];
    const stats = { carried: 0 };
    // Same id → carried by id, not counted as a fingerprint carry.
    const byId = mapAnnotations(
      [ann("a", { comment: "Tighten this.", anchoredText: "some words" })],
      SOURCE,
      { threshold: 0.55 },
      prev,
      stats
    );
    assert.strictEqual(byId[0].resolved, true);
    assert.strictEqual(stats.carried, 0);

    // New id AND different words → nothing to inherit.
    const different = mapAnnotations(
      [ann("b", { comment: "A brand new remark.", anchoredText: "other words" })],
      SOURCE,
      { threshold: 0.55 },
      prev,
      stats
    );
    assert.strictEqual(different[0].resolved, false);
    assert.strictEqual(stats.carried, 0);
  });

  it("pairs duplicate identical remarks one-to-one in document order", () => {
    const dup = (id: string, note: string): ReviewItem => ({
      ...ann(id, { comment: "Fix punctuation." }),
      match: null,
      resolved: false,
      note,
    });
    const items = mapAnnotations(
      [ann("n1", { comment: "Fix punctuation." }), ann("n2", { comment: "Fix punctuation." })],
      SOURCE,
      { threshold: 0.55 },
      [dup("o1", "first"), dup("o2", "second")]
    );
    assert.deepStrictEqual(
      items.map((i) => i.note),
      ["first", "second"]
    );
  });

  it("sorts matched items by source line, unmatched last", () => {
    const items = mapAnnotations(
      [
        ann("later", { anchoredText: "Reification lets us make statements" }),
        ann("nope", { anchoredText: "zzz nothing matches this zzz" }),
        ann("early", {
          anchoredText: "Knowledge graphs put relationships first",
        }),
      ],
      SOURCE,
      { threshold: 0.6 }
    );
    assert.deepStrictEqual(
      items.map((i) => i.id),
      ["early", "later", "nope"]
    );
  });
});
