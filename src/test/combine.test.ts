/**
 * Appending and merging are where review work could be lost or doubled: a
 * re-sent PDF repeats every earlier mark, and a merge moves the author's
 * resolutions and replies between files. Both directions are pinned here.
 */
import * as assert from "node:assert";
import {
  appendItems,
  mergeInto,
  namespacedId,
  nextPdfId,
  rawIdOf,
} from "../core/model/combine.js";
import type { PdfSource, ReviewItem, ReviewSession } from "../core/model/types.js";

function item(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "highlight",
    page: 1,
    comment: `Remark ${id}`,
    anchoredText: `text of ${id}`,
    rect: [72, 700, 300, 712],
    match: { startLine: 3, endLine: 3, score: 0.9, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

function session(id: string, items: ReviewItem[], over: Partial<ReviewSession> = {}): ReviewSession {
  return {
    version: 3,
    sidecarPath: `/book/.eddie/ch1/rev-1/${id}.review.json`,
    adocPath: "/book/ch1.adoc",
    pdfPath: `/book/in/${id}.pdf`,
    revision: { id: "rev-1", ordinal: 1 },
    mapping: { id, kind: "annotations" },
    pdf: { role: "annotated" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    integrity: { pdfSha256: id.padEnd(64, "0"), pdfAnnotationCount: items.length },
    items,
    ...over,
  };
}

function source(id: string, over: Partial<PdfSource> = {}): PdfSource {
  return { id, path: `/book/in/${id}.pdf`, role: "annotated", ...over };
}

describe("pdf ids", () => {
  it("counts on from the mapping's own PDF", () => {
    const s = session("acme", []);
    assert.strictEqual(nextPdfId(s), "pdf-2");
    s.extraPdfs = [source("pdf-2"), source("pdf-7")];
    assert.strictEqual(nextPdfId(s), "pdf-8");
    assert.strictEqual(nextPdfId(s, ["pdf-8"]), "pdf-9");
  });

  it("namespaces ids from added PDFs and can undo it", () => {
    const id = namespacedId("pdf-2", "p1-highlight-72-700");
    assert.strictEqual(id, "pdf-2/p1-highlight-72-700");
    assert.strictEqual(rawIdOf(item(id, { pdfId: "pdf-2" })), "p1-highlight-72-700");
    assert.strictEqual(rawIdOf(item("p1-x")), "p1-x");
  });
});

describe("appendItems", () => {
  it("adds a second editor's marks after the first's, keeping every number", () => {
    const s = session("acme", [
      item("a", { number: 1, initials: "RG", author: "Rachel Green" }),
      item("b", { number: 2, initials: "RG", author: "Rachel Green", page: 2 }),
    ]);
    const res = appendItems(
      s,
      source("pdf-2"),
      [
        item("a", { author: "Mo Rahimi", comment: "Different remark, same spot" }),
        item("z", { page: 3 }),
      ],
      () => "Mo Rahimi"
    );
    assert.strictEqual(res.added.length, 2);
    assert.strictEqual(res.duplicates, 0);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    assert.deepStrictEqual([byId.get("a")!.number, byId.get("b")!.number], [1, 2]);
    // Same geometry, different PDF: the ids must not collide.
    assert.ok(byId.has("pdf-2/a"));
    assert.deepStrictEqual(
      [byId.get("pdf-2/a")!.number, byId.get("pdf-2/a")!.initials],
      [3, "MR"]
    );
    assert.strictEqual(byId.get("pdf-2/z")!.number, 4);
    assert.strictEqual(byId.get("pdf-2/z")!.pdfId, "pdf-2");
    assert.deepStrictEqual(s.extraPdfs?.map((p) => p.id), ["pdf-2"]);
  });

  it("continues a review: a re-sent PDF only contributes its new marks", () => {
    const s = session("acme", [
      item("a", { number: 1, resolved: true }),
      item("b", { number: 2, page: 2 }),
    ]);
    // The editor's second copy repeats both marks — re-keyed by the re-export —
    // and adds one.
    const res = appendItems(s, source("pdf-2"), [
      item("a-rekeyed", { comment: "Remark a", anchoredText: "text of a" }),
      item("b-rekeyed", { comment: "Remark b", anchoredText: "text of b", page: 2 }),
      item("c", { page: 4 }),
    ]);
    assert.strictEqual(res.duplicates, 2);
    assert.deepStrictEqual(res.added.map((i) => i.id), ["pdf-2/c"]);
    assert.strictEqual(s.items.length, 3);
    assert.strictEqual(s.items.find((i) => i.id === "a")!.resolved, true);
    assert.strictEqual(res.added[0].number, 3);
  });

  it("treats the same bare remark on another page as a new remark", () => {
    const s = session("acme", [item("a", { number: 1, comment: "", page: 1 })]);
    const res = appendItems(s, source("pdf-2"), [
      item("a", { comment: "", page: 1 }),
      item("a", { comment: "", page: 5 }),
    ]);
    assert.strictEqual(res.duplicates, 1);
    assert.strictEqual(res.added.length, 1);
    assert.strictEqual(res.added[0].page, 5);
  });

  it("absorbs repeats one for one, not all copies of a repeated remark", () => {
    const s = session("acme", [item("a", { number: 1 })]);
    const res = appendItems(s, source("pdf-2"), [item("a"), item("a#1")]);
    assert.strictEqual(res.duplicates, 1);
    assert.strictEqual(res.added.length, 1);
  });
});

describe("mergeInto", () => {
  it("moves another editor's mapping in, with everything the author did to it", () => {
    const target = session(
      "acme",
      [item("a", { number: 1, initials: "RG" }), item("b", { number: 2, initials: "RG" })],
      { mapping: { id: "acme", kind: "annotations", origin: "Acme" } }
    );
    const other = session(
      "beta",
      [
        item("x", {
          number: 2,
          initials: "MR",
          author: "Mo Rahimi",
          comment: "Second of Mo's",
          page: 1,
          rect: [72, 100, 300, 112],
        }),
        item("y", {
          number: 1,
          initials: "MR",
          author: "Mo Rahimi",
          comment: "First of Mo's",
          page: 9,
          resolved: true,
          note: "handled in draft 3",
          manualLine: 40,
          confirmed: true,
          replies: [{ id: "r-1", author: "VP", createdAt: "2026-09-02T00:00:00Z", body: "Done." }],
          anchor: { marker: "abc12345" },
        }),
      ],
      {
        mapping: { id: "beta", kind: "annotations", origin: "Beta Proofing", reviewer: "Mo Rahimi" },
        artifacts: [{ kind: "report", path: "/book/.eddie/ch1/rev-1/beta.review.md" }],
      }
    );

    const res = mergeInto(target, [other], "2026-09-16T00:00:00.000Z");
    assert.deepStrictEqual(res, { moved: 2, folded: 0, pdfsAdded: 1 });

    const byRaw = new Map(target.items.map((i) => [rawIdOf(i), i]));
    // Mo's list keeps its own order after the target's: his #1 then his #2.
    assert.strictEqual(byRaw.get("y")!.number, 3);
    assert.strictEqual(byRaw.get("x")!.number, 4);
    assert.strictEqual(byRaw.get("x")!.initials, "MR");

    const y = byRaw.get("y")!;
    assert.strictEqual(y.id, "pdf-2/y");
    assert.strictEqual(y.pdfId, "pdf-2");
    assert.strictEqual(y.resolved, true);
    assert.strictEqual(y.note, "handled in draft 3");
    assert.strictEqual(y.manualLine, 40);
    assert.strictEqual(y.confirmed, true);
    assert.strictEqual(y.replies?.[0].body, "Done.");
    assert.deepStrictEqual(y.anchor, { marker: "abc12345" });

    assert.deepStrictEqual(target.extraPdfs, [
      {
        id: "pdf-2",
        path: "/book/in/beta.pdf",
        role: "annotated",
        imported: undefined,
        importedFrom: undefined,
        sha256: "beta".padEnd(64, "0"),
        annotationCount: 2,
        addedAt: "2026-09-16T00:00:00.000Z",
        origin: "Beta Proofing",
        reviewer: "Mo Rahimi",
      },
    ]);
    assert.strictEqual(target.artifacts?.length, 1);
    // The target's own remarks are untouched.
    assert.deepStrictEqual(
      target.items.filter((i) => !i.pdfId).map((i) => [i.id, i.number]).sort(),
      [["a", 1], ["b", 2]]
    );
  });

  it("carries the merged mapping's own added PDFs across, renamed", () => {
    const target = session("acme", [item("a", { number: 1 })], {
      extraPdfs: [source("pdf-2")],
    });
    const other = session(
      "beta",
      [
        item("x", { number: 1, comment: "own" }),
        item("pdf-2/q", { number: 2, pdfId: "pdf-2", comment: "added" }),
      ],
      { extraPdfs: [source("pdf-2", { path: "/book/in/beta-second.pdf", reviewer: "Lee" })] }
    );
    const res = mergeInto(target, [other]);
    assert.strictEqual(res.pdfsAdded, 2);
    assert.deepStrictEqual(
      target.extraPdfs?.map((p) => [p.id, p.path]),
      [
        ["pdf-2", "/book/in/pdf-2.pdf"],
        ["pdf-3", "/book/in/beta.pdf"],
        ["pdf-4", "/book/in/beta-second.pdf"],
      ]
    );
    const ids = target.items.map((i) => i.id).sort();
    assert.deepStrictEqual(ids, ["a", "pdf-3/x", "pdf-4/q"]);
    assert.strictEqual(target.items.find((i) => i.id === "pdf-4/q")!.pdfId, "pdf-4");
    assert.strictEqual(target.extraPdfs![2].reviewer, "Lee");
  });

  it("folds a remark both mappings hold into one, losing nothing", () => {
    const target = session("acme", [
      item("a", {
        number: 1,
        note: "mine",
        replies: [{ id: "r-1", author: "VP", createdAt: "2026-09-01T00:00:00Z", body: "first" }],
      }),
    ]);
    const other = session("acme-again", [
      item("a-rekeyed", {
        comment: "Remark a",
        anchoredText: "text of a",
        number: 1,
        resolved: true,
        note: "theirs",
        replies: [
          { id: "r-1", author: "VP", createdAt: "2026-09-01T00:00:00Z", body: "first" },
          { id: "r-2", author: "VP", createdAt: "2026-09-03T00:00:00Z", body: "second" },
        ],
      }),
    ]);
    const res = mergeInto(target, [other]);
    assert.deepStrictEqual([res.moved, res.folded], [0, 1]);
    assert.strictEqual(target.items.length, 1);
    const a = target.items[0];
    assert.strictEqual(a.number, 1);
    assert.strictEqual(a.resolved, true);
    assert.strictEqual(a.note, "mine\n\ntheirs");
    assert.deepStrictEqual(a.replies?.map((r) => r.id), ["r-1", "r-2"]);
  });

  it("numbers several merged mappings one after another", () => {
    const target = session("t", [item("a", { number: 1 })]);
    const b = session("b", [item("b1", { number: 1 }), item("b2", { number: 2, page: 2 })]);
    const c = session("c", [item("c1", { number: 1 })]);
    mergeInto(target, [b, c]);
    const numberOf = (raw: string) => target.items.find((i) => rawIdOf(i) === raw)!.number;
    assert.deepStrictEqual(
      ["a", "b1", "b2", "c1"].map(numberOf),
      [1, 2, 3, 4]
    );
    assert.deepStrictEqual(target.extraPdfs?.map((p) => p.id), ["pdf-2", "pdf-3"]);
    assert.ok(target.items.every((i) => !i.pdfId || target.extraPdfs!.some((p) => p.id === i.pdfId)));
  });
});
