import * as assert from "node:assert";
import {
  mapAnnotations,
  effectiveLine,
  isConfident,
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

  it("holds a lost anchor where it was, rather than searching from scratch", () => {
    // Every tier failed: no marker, no block id, no recognisable fingerprint.
    // Searching from here is precisely the case that lands on the decoy, so the
    // item keeps the last place it was known to be and is flagged for a human.
    const gutted = [
      "= Doc",
      "",
      "Identity is the component the whole book rests on.",
      "",
      "The previous chapter looked at agents from the outside and",
      "classified them by autonomy, architecture and mission.",
    ].join("\n");
    const prior = priorWith({ marker: "aaaaaaaa" });
    prior[0].match = {
      startLine: 2,
      endLine: 2,
      score: 1,
      method: "marker",
      sourceExcerpt: "",
    };
    const stats: MapStats = { carried: 0 };
    const items = mapAnnotations([editorsWording], gutted, { threshold: 0.5 }, prior, stats);

    assert.strictEqual(stats.anchorsLost, 1);
    assert.strictEqual(stats.anchored, 0);
    assert.strictEqual(stats.stale, 1);
    assert.strictEqual(items.length, 1, "never silently dropped");
    assert.strictEqual(effectiveLine(items[0]), 2, "held, not moved to the decoy");
    assert.strictEqual(items[0].stale, true);
  });
});

/**
 * The rule that keeps a review honest across a rewrite: **re-matching can only
 * degrade a link that already exists.** The matcher compares the editor's
 * original PDF wording against the source as it is now, so once the marked
 * sentence has been rewritten, the best remaining candidate is some other
 * paragraph that still shares its vocabulary — a confident wrong answer. These
 * cases pin what is allowed to move a mark, and what is not.
 */
describe("mapAnnotations defends established links", () => {
  const SHIFTED = ["", "", ...SOURCE.split("\n")].join("\n");
  const reified = ann("x", {
    anchoredText: "Reification lets us make statements about statements",
  });

  /** A prior item linked to `line`, with no anchor and no human judgement on it. */
  function linkedAt(line: number, score = 1): ReviewItem[] {
    return [
      {
        ...reified,
        match: { startLine: line, endLine: line, score, method: "fuzzy", sourceExcerpt: "" },
        resolved: false,
      } as ReviewItem,
    ];
  }

  it("follows the text when an ordinary edit moves it", () => {
    // Two lines inserted above: the marked sentence is intact, just lower down.
    const items = mapAnnotations([reified], SHIFTED, { threshold: 0.5 }, linkedAt(4));
    assert.strictEqual(effectiveLine(items[0]), 6);
    assert.strictEqual(items[0].stale, undefined, "moving with the text is not staleness");
  });

  it("refuses to move a mark onto a materially worse match", () => {
    const rewritten = [
      "= Doc",
      "",
      "Identity is the component the whole book rests on.",
      "",
      "Statements about statements are what reification gives us, loosely.",
    ].join("\n");
    // Standing link at line 2 scored 1.0 when it was made. The only candidate
    // left scores far lower — that is evidence the text changed, not evidence
    // the mark belongs somewhere else.
    const items = mapAnnotations([reified], rewritten, { threshold: 0.2 }, linkedAt(2));
    assert.strictEqual(effectiveLine(items[0]), 2, "held at its last known place");
    assert.strictEqual(items[0].stale, true);
  });

  it("keeps a position rather than blanking it when the words are gone", () => {
    const unrelated = ["= Doc", "", "Nothing here resembles the mark at all."].join("\n");
    const items = mapAnnotations([reified], unrelated, { threshold: 0.9 }, linkedAt(2));
    assert.strictEqual(effectiveLine(items[0]), 2);
    assert.strictEqual(items[0].stale, true);
  });

  it("never re-litigates a link the author placed by hand", () => {
    const prior = linkedAt(2, 0.4);
    prior[0].manualLine = 2;
    const items = mapAnnotations([reified], SHIFTED, { threshold: 0.5 }, prior);
    // The sentence really is at line 6 now — but the author put this mark on
    // line 2 and only they get to move it.
    assert.strictEqual(effectiveLine(items[0]), 2);
    assert.strictEqual(items[0].match?.startLine, 2, "not re-searched");
  });

  it("carries a confirmation across a re-map, and does not re-search it", () => {
    const prior = linkedAt(2, 0.6);
    prior[0].confirmed = true;
    const items = mapAnnotations([reified], SHIFTED, { threshold: 0.5 }, prior);
    assert.strictEqual(items[0].confirmed, true, "the author's vouch survives");
    assert.strictEqual(items[0].match?.startLine, 2);
  });

  it("searches freely when there is nothing to protect", () => {
    const items = mapAnnotations([reified], SHIFTED, { threshold: 0.5 });
    assert.strictEqual(effectiveLine(items[0]), 6);
    const stats: MapStats = { carried: 0 };
    mapAnnotations([reified], SHIFTED, { threshold: 0.5 }, undefined, stats);
    assert.strictEqual(stats.kept, 0);
  });
});

describe("isConfident", () => {
  function item(over: Partial<ReviewItem> = {}): ReviewItem {
    return {
      ...ann("x"),
      match: { startLine: 1, endLine: 1, score: 0.95, method: "fuzzy", sourceExcerpt: "" },
      resolved: false,
      ...over,
    } as ReviewItem;
  }

  it("trusts a strong score, a hand-picked line, and a vouch", () => {
    assert.strictEqual(isConfident(item(), 0.75), true);
    assert.strictEqual(isConfident(item({ manualLine: 3 }), 0.75), true);
    assert.strictEqual(isConfident(item({ confirmed: true }), 0.75), true);
  });

  it("trusts nothing stale, however the link was made", () => {
    // The position may well still be right — but the text it described has
    // changed, and only a person can say whether the remark still applies.
    assert.strictEqual(isConfident(item({ stale: true }), 0.75), false);
    assert.strictEqual(isConfident(item({ stale: true, manualLine: 3 }), 0.75), false);
    assert.strictEqual(isConfident(item({ stale: true, confirmed: true }), 0.75), false);
  });

  it("does not trust a weak auto-match", () => {
    assert.strictEqual(isConfident(item({ match: null }), 0.75), false);
  });
});
