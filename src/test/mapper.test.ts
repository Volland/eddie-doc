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
