/**
 * Reply-thread semantics, exercised through the format layer.
 *
 * `ReviewStore` imports `vscode`, which does not exist under mocha, so these
 * tests cover the persistence contract the store depends on: that a thread
 * survives a serialize/parse round trip intact, in order, and that the
 * malformed-entry guards hold. The store's own mutations are thin wrappers over
 * array operations on top of this.
 */
import * as assert from "node:assert";
import { parse, serialize, toDocument } from "../model/format.js";
import type { Reply, ReviewItem, ReviewSession } from "../model/types.js";

const SIDECAR = "/proj/book/chapter-01.review.json";

function reply(id: string, body: string, when: string): Reply {
  return { id, author: "Volodymyr Pavlyshyn", createdAt: when, body };
}

function sessionWith(replies: Reply[] | undefined): ReviewSession {
  const item: ReviewItem = {
    id: "p1-highlight-48-287",
    kind: "strikeout",
    page: 1,
    comment: "Cut — repeats the intro.",
    anchoredText: "Two debts from earlier chapters come due here.",
    author: "Rachel",
    rect: [48, 287, 563, 325],
    match: { startLine: 29, endLine: 29, score: 1, method: "marker", sourceExcerpt: "…" },
    resolved: false,
    replies,
  };
  return {
    version: 2,
    adocPath: "/proj/book/chapter-01.adoc",
    pdfPath: "/proj/book/chapter-01.annotated.pdf",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    items: [item],
  };
}

function roundTrip(s: ReviewSession): ReviewItem {
  const after = parse(serialize(s, SIDECAR), SIDECAR, s.adocPath);
  assert.ok(after);
  return after!.items[0];
}

describe("reply threads", () => {
  it("preserves thread order across a round trip", () => {
    const thread = [
      reply("r-1", "Tightened this.", "2026-08-07T10:00:00.000Z"),
      reply("r-2", "Also cut the trailing clause.", "2026-08-07T11:00:00.000Z"),
      reply("r-3", "Rachel, does this read better?", "2026-08-07T12:00:00.000Z"),
    ];
    const out = roundTrip(sessionWith(thread));
    assert.deepStrictEqual(
      out.replies?.map((r) => r.id),
      ["r-1", "r-2", "r-3"]
    );
    assert.deepStrictEqual(out.replies, thread);
  });

  it("keeps replies under state, beside the rest of the user's decisions", () => {
    const doc = toDocument(sessionWith([reply("r-1", "Done.", "2026-08-07T10:00:00.000Z")]), SIDECAR);
    assert.strictEqual(doc.items[0].state.replies?.length, 1);
    // Never on the annotation block: that is the editor's, and is immutable.
    assert.ok(!("replies" in doc.items[0].annotation));
  });

  it("drops empty-bodied entries rather than persisting blanks", () => {
    const out = roundTrip(
      sessionWith([
        reply("r-1", "Real reply.", "2026-08-07T10:00:00.000Z"),
        reply("r-2", "", "2026-08-07T11:00:00.000Z"),
      ])
    );
    assert.strictEqual(out.replies?.length, 1);
    assert.strictEqual(out.replies?.[0].id, "r-1");
  });

  it("normalizes an emptied thread to absent, not an empty array", () => {
    const out = roundTrip(sessionWith([]));
    assert.strictEqual(out.replies, undefined);
    const alsoEmpty = roundTrip(sessionWith([reply("r-1", "", "2026-08-07T10:00:00.000Z")]));
    assert.strictEqual(alsoEmpty.replies, undefined);
  });

  it("preserves multi-line reply bodies verbatim", () => {
    const body = "Two changes:\n\n- named the debts directly\n- cut the preamble";
    const out = roundTrip(sessionWith([reply("r-1", body, "2026-08-07T10:00:00.000Z")]));
    assert.strictEqual(out.replies?.[0].body, body);
  });

  it("keeps the editor's own comment separate from the reply thread", () => {
    const out = roundTrip(sessionWith([reply("r-1", "Fixed.", "2026-08-07T10:00:00.000Z")]));
    assert.strictEqual(out.comment, "Cut — repeats the intro.");
    assert.strictEqual(out.author, "Rachel");
    assert.strictEqual(out.replies?.[0].author, "Volodymyr Pavlyshyn");
  });
});
