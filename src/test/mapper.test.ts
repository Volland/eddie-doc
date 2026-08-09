import * as assert from "node:assert";
import {
  mapAnnotations,
  effectiveLine,
  type MapStats,
} from "../matching/mapper.js";
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
    const stats: MapStats = { carried: 0 };
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
    const stats: MapStats = { carried: 0 };
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

describe("mapAnnotations with source anchors", () => {
  // The scenario this whole mechanism exists for, drawn from a real chapter:
  // the editor marked a sentence, the author then rewrote it, and the editor's
  // wording no longer appears anywhere. Fuzzy matching does not fail here — it
  // succeeds, confidently, on the wrong paragraph. The anchor prevents that.
  // The paragraph the editor marked has been rewritten so completely that none
  // of her wording survives in it — while another paragraph further down still
  // shares most of those words. This is the shape of the real CH04 failure.
  const REWRITTEN = [
    "= Doc", // 0
    "", // 1
    "// eddie:aaaaaaaa", // 2
    "Identity is the component the whole book rests on.", // 3  <- the right place
    "", // 4
    "The previous chapter looked at agents from the outside and", // 5  <- decoy
    "classified them by autonomy, architecture and mission.", // 6
  ].join("\n");

  const editorsWording = ann("x", {
    anchoredText:
      "The previous chapter looked at agents from the outside, and classified " +
      "them three ways: by autonomy, by architecture, and by mission.",
  });

  function priorWith(anchor?: ReviewItem["anchor"]): ReviewItem[] {
    return [
      {
        ...editorsWording,
        match: null,
        resolved: false,
        anchor,
      } as ReviewItem,
    ];
  }

  it("places an item by its marker, not by searching", () => {
    const stats: MapStats = { carried: 0 };
    const items = mapAnnotations(
      [editorsWording],
      REWRITTEN,
      { threshold: 0.5 },
      priorWith({ marker: "aaaaaaaa" }),
      stats
    );
    assert.strictEqual(items[0].match?.method, "marker");
    assert.strictEqual(items[0].match?.score, 1);
    assert.strictEqual(effectiveLine(items[0]), 3);
    assert.strictEqual(stats.anchored, 1);
    assert.strictEqual(stats.anchorsLost, 0);
  });

  it("rescues an item fuzzy matching would confidently misplace", () => {
    const without = mapAnnotations(
      [editorsWording],
      REWRITTEN,
      { threshold: 0.5 },
      priorWith(undefined)
    );
    // Unanchored, the matcher does not fail — it succeeds on the WRONG
    // paragraph, because that is where the editor's old wording still lives.
    assert.ok(without[0].match, "fuzzy finds a confident match");
    assert.strictEqual(effectiveLine(without[0]), 5, "…and it is the decoy");

    const withAnchor = mapAnnotations(
      [editorsWording],
      REWRITTEN,
      { threshold: 0.5 },
      priorWith({ marker: "aaaaaaaa" })
    );
    assert.strictEqual(effectiveLine(withAnchor[0]), 3, "anchor wins");
    assert.strictEqual(withAnchor[0].match?.method, "marker");
  });

  it("carries the anchor and replies across a re-map", () => {
    const prior = priorWith({ marker: "aaaaaaaa" });
    prior[0].replies = [
      { id: "r1", author: "Author", createdAt: "2026-08-07T00:00:00Z", body: "Fixed." },
    ];
    const items = mapAnnotations(
      [editorsWording],
      REWRITTEN,
      { threshold: 0.5 },
      prior
    );
    assert.deepStrictEqual(items[0].anchor, { marker: "aaaaaaaa" });
    assert.strictEqual(items[0].replies?.[0].body, "Fixed.");
  });

  it("reports a lost anchor and falls back to searching", () => {
    const gutted = ["= Doc", "", "Reification lets us make statements."].join("\n");
    const stats: MapStats = { carried: 0 };
    const items = mapAnnotations(
      [editorsWording],
      gutted,
      { threshold: 0.5 },
      priorWith({ marker: "aaaaaaaa" }),
      stats
    );
    assert.strictEqual(stats.anchorsLost, 1);
    assert.strictEqual(stats.anchored, 0);
    // The item is not silently dropped — it still exists to be triaged.
    assert.strictEqual(items.length, 1);
    assert.notStrictEqual(items[0].match?.method, "marker");
  });
});
