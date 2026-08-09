import * as assert from "node:assert";
import {
  describeAnchor,
  enclosingBlockId,
  findMarkers,
  injectMarkers,
  insertionLineFor,
  isMarkerLine,
  resolveAnchor,
  stripMarkers,
} from "../source/markers.js";

/** A chapter shaped like the real manuscript: attribute lines, figures, prose. */
const DOC = [
  "= Anatomy of an Agent", // 0
  ":sectnums:", // 1
  "", // 2
  "Two debts from earlier chapters come due here. Chapter 2 designed a", // 3
  "memory system in the abstract: tiered stores governed by an executive.", // 4
  "", // 5
  "[#ch04-figure-anatomy, reftext={chapter}.{counter:figure}]", // 6
  ".The anatomy of an agent", // 7
  "image::anatomy.png[]", // 8
  "", // 9
  "Entities are stable and reusable across the graph, so a query can rely", // 10
  "on them holding still while the edges around them change.", // 11
  "", // 12
  "== Components", // 13
  "", // 14
  "An agent is assembled from eight parts.", // 15
].join("\n");

const lines = DOC.split("\n");

describe("marker lines", () => {
  it("recognises only its own comment form", () => {
    assert.ok(isMarkerLine("// eddie:a3f21c94"));
    assert.ok(isMarkerLine("//eddie:deadbeef"));
    assert.ok(!isMarkerLine("// eddie says hello"));
    assert.ok(!isMarkerLine("// a normal comment"));
    assert.ok(!isMarkerLine("Two debts from earlier chapters"));
  });

  it("finds markers and reports the content line they anchor", () => {
    const src = ["// eddie:aaaaaaaa", "Some prose here."].join("\n");
    const found = findMarkers(src);
    assert.strictEqual(found.size, 1);
    const hit = found.get("aaaaaaaa")!;
    assert.strictEqual(hit.markerLine, 0);
    assert.strictEqual(hit.targetLine, 1);
  });

  it("anchors past attribute and title lines to the real content", () => {
    const src = [
      "// eddie:bbbbbbbb",
      "[#fig-one]",
      ".A caption",
      "image::x.png[]",
    ].join("\n");
    const hit = findMarkers(src).get("bbbbbbbb")!;
    assert.strictEqual(hit.targetLine, 3, "should skip [#id] and .caption");
  });

  it("strips markers and leaves everything else byte-identical", () => {
    const withMarkers = ["// eddie:cccccccc", ...lines].join("\n");
    assert.strictEqual(stripMarkers(withMarkers), DOC);
    // Ordinary comments are not ours to remove.
    const mixed = "// a real comment\n// eddie:dddddddd\ntext";
    assert.strictEqual(stripMarkers(mixed), "// a real comment\ntext");
  });
});

describe("insertion points", () => {
  it("walks up to the first line of a wrapped paragraph", () => {
    // Line 4 is the continuation of the paragraph starting at 3.
    assert.strictEqual(insertionLineFor(lines, 4), 3);
  });

  it("never splits an attribute list from the block it describes", () => {
    // Targeting the image (8) must insert above [#id] (6), not between them.
    assert.strictEqual(insertionLineFor(lines, 8), 6);
    // Same when targeting the caption line itself.
    assert.strictEqual(insertionLineFor(lines, 7), 6);
  });
});

describe("enclosingBlockId", () => {
  it("finds the id the author put on a figure", () => {
    assert.strictEqual(enclosingBlockId(DOC, 8), "ch04-figure-anatomy");
    assert.strictEqual(enclosingBlockId(DOC, 7), "ch04-figure-anatomy");
  });

  it("returns undefined for plain prose", () => {
    assert.strictEqual(enclosingBlockId(DOC, 3), undefined);
    assert.strictEqual(enclosingBlockId(DOC, 10), undefined);
  });

  it("understands the legacy [[anchor]] form", () => {
    const src = "[[old-style]]\nSome prose.";
    assert.strictEqual(enclosingBlockId(src, 1), "old-style");
  });
});

describe("injectMarkers", () => {
  it("inserts above the paragraph and reports the assignment", () => {
    const r = injectMarkers(DOC, [{ itemId: "p1-highlight-48-287", line: 4 }]);
    assert.strictEqual(r.inserted, 1);
    const id = r.assigned.get("p1-highlight-48-287")!;
    assert.match(id, /^[0-9a-f]{8}$/);
    const out = r.source.split("\n");
    assert.strictEqual(out[3], `// eddie:${id}`);
    assert.strictEqual(out[4], lines[3], "paragraph itself is untouched");
    // And the marker resolves back to the paragraph's first line.
    assert.strictEqual(findMarkers(r.source).get(id)!.targetLine, 4);
  });

  it("keeps line numbers valid when inserting several, bottom-up", () => {
    const r = injectMarkers(DOC, [
      { itemId: "a", line: 3 },
      { itemId: "b", line: 8 },
      { itemId: "c", line: 10 },
    ]);
    assert.strictEqual(r.inserted, 3);
    const markers = findMarkers(r.source);
    // Every marker must land on the block it was asked for, not one adrift.
    const out = r.source.split("\n");
    assert.strictEqual(
      out[markers.get(r.assigned.get("a")!)!.targetLine],
      lines[3]
    );
    assert.strictEqual(
      out[markers.get(r.assigned.get("b")!)!.targetLine],
      lines[8]
    );
    assert.strictEqual(
      out[markers.get(r.assigned.get("c")!)!.targetLine],
      lines[10]
    );
  });

  it("shares one marker between items on the same block", () => {
    const r = injectMarkers(DOC, [
      { itemId: "x", line: 3 },
      { itemId: "y", line: 4 }, // same paragraph
    ]);
    assert.strictEqual(r.inserted, 1);
    assert.strictEqual(r.assigned.get("x"), r.assigned.get("y"));
  });

  it("is idempotent — a second run inserts nothing and changes no bytes", () => {
    const first = injectMarkers(DOC, [
      { itemId: "a", line: 3 },
      { itemId: "b", line: 8 },
    ]);
    const second = injectMarkers(first.source, [
      { itemId: "a", line: findMarkers(first.source).get(first.assigned.get("a")!)!.targetLine },
      { itemId: "b", line: findMarkers(first.source).get(first.assigned.get("b")!)!.targetLine },
    ]);
    assert.strictEqual(second.inserted, 0);
    assert.strictEqual(second.source, first.source);
    assert.strictEqual(second.assigned.get("a"), first.assigned.get("a"));
  });

  it("round-trips: inject then strip returns the original source", () => {
    const r = injectMarkers(DOC, [
      { itemId: "a", line: 3 },
      { itemId: "b", line: 8 },
      { itemId: "c", line: 15 },
    ]);
    assert.notStrictEqual(r.source, DOC);
    assert.strictEqual(stripMarkers(r.source), DOC);
  });

  it("gives different items on different blocks different ids", () => {
    const r = injectMarkers(DOC, [
      { itemId: "a", line: 3 },
      { itemId: "b", line: 10 },
    ]);
    assert.notStrictEqual(r.assigned.get("a"), r.assigned.get("b"));
  });
});

describe("resolveAnchor", () => {
  it("resolves through the marker even after the prose is rewritten", () => {
    const r = injectMarkers(DOC, [{ itemId: "a", line: 3 }]);
    const id = r.assigned.get("a")!;
    // Rewrite the anchored paragraph wholesale — no shared wording survives.
    const edited = r.source
      .split("\n")
      .map((l) =>
        l.startsWith("Two debts") ? "Two debts come into play here:" : l
      )
      .filter((l) => !l.startsWith("memory system in the abstract"))
      .join("\n");

    const hit = resolveAnchor(edited, { marker: id });
    assert.ok(hit, "marker must survive a full rewrite of its paragraph");
    assert.strictEqual(hit!.method, "marker");
    assert.strictEqual(
      edited.split("\n")[hit!.line],
      "Two debts come into play here:"
    );
  });

  it("falls back to the block id when no marker was injected", () => {
    const hit = resolveAnchor(DOC, { blockId: "ch04-figure-anatomy" });
    assert.ok(hit);
    assert.strictEqual(hit!.method, "blockId");
    // The span covers the figure — caption line and image macro together.
    assert.ok(hit!.line <= 8 && hit!.endLine >= 8, "span must cover the image");
    assert.ok(
      DOC.split("\n").slice(hit!.line, hit!.endLine + 1).join("\n").includes("anatomy.png")
    );
  });

  it("falls back to the block fingerprint when the id is gone too", () => {
    const anchor = describeAnchor(DOC, 10);
    assert.ok(anchor.blockFingerprint);
    // Move the paragraph elsewhere in the document; the fingerprint still finds it.
    const moved = [
      "= Anatomy of an Agent",
      "",
      "Entities are stable and reusable across the graph, so a query can rely",
      "on them holding still while the edges around them change.",
    ].join("\n");
    const hit = resolveAnchor(moved, {
      blockFingerprint: anchor.blockFingerprint,
    });
    assert.ok(hit);
    assert.strictEqual(hit!.method, "fingerprint");
    assert.strictEqual(hit!.line, 2);
  });

  it("prefers the marker over the weaker tiers", () => {
    const r = injectMarkers(DOC, [{ itemId: "a", line: 10 }]);
    const id = r.assigned.get("a")!;
    const hit = resolveAnchor(r.source, {
      marker: id,
      blockId: "ch04-figure-anatomy", // deliberately points elsewhere
    });
    assert.strictEqual(hit!.method, "marker");
    assert.match(r.source.split("\n")[hit!.line], /^Entities are stable/);
  });

  it("returns null when the anchored text was deleted outright", () => {
    const r = injectMarkers(DOC, [{ itemId: "a", line: 3 }]);
    const id = r.assigned.get("a")!;
    const anchor = describeAnchor(r.source, 4, id);
    // Delete the marker and its paragraph — the item is genuinely orphaned.
    const gutted = r.source
      .split("\n")
      .filter(
        (l) =>
          !l.includes(`eddie:${id}`) &&
          !l.startsWith("Two debts") &&
          !l.startsWith("memory system in the abstract")
      )
      .join("\n");
    assert.strictEqual(resolveAnchor(gutted, anchor), null);
  });

  it("returns null for an item that was never anchored", () => {
    assert.strictEqual(resolveAnchor(DOC, undefined), null);
    assert.strictEqual(resolveAnchor(DOC, {}), null);
  });
});

describe("describeAnchor", () => {
  it("captures block id, fingerprint and surrounding context", () => {
    const a = describeAnchor(DOC, 10, "feedface");
    assert.strictEqual(a.marker, "feedface");
    assert.match(a.blockFingerprint!, /^[0-9a-f]{16}$/);
    // The block before is the figure, the block after is the section heading run.
    assert.ok(a.contextBefore && a.contextBefore.length > 0);
    assert.ok(a.contextAfter && a.contextAfter.length > 0);
  });

  it("fingerprints reflowed prose identically", () => {
    const wrapped = "Entities are stable and reusable across the graph, so a\nquery can rely on them.";
    const oneLine = "Entities are stable and reusable across the graph, so a query can rely on them.";
    assert.strictEqual(
      describeAnchor(wrapped, 0).blockFingerprint,
      describeAnchor(oneLine, 0).blockFingerprint
    );
  });
});
