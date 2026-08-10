/**
 * Thread rendering inputs.
 *
 * The signature is what decides whether a live comment thread is left alone on
 * refresh. Getting it wrong in one direction shows stale replies; wrong in the
 * other throws away the popup — and the half-typed reply in it — on every store
 * change. Both directions are pinned here.
 */
import * as assert from "node:assert";
import {
  markAuthor,
  rootMarkdown,
  threadLabel,
  threadSignature,
} from "../ui/threadModel.js";
import type { Reply, ReviewItem } from "../model/types.js";

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "p1-highlight-48-287",
    kind: "highlight",
    page: 3,
    comment: "Tighten this.",
    anchoredText: "Two debts\n  from earlier chapters come due here.",
    author: "Rachel",
    rect: [48, 287, 563, 325],
    match: { startLine: 29, endLine: 29, score: 0.87, method: "fuzzy", sourceExcerpt: "…" },
    resolved: false,
    ...over,
  } as ReviewItem;
}

function reply(over: Partial<Reply> = {}): Reply {
  return {
    id: "r1",
    author: "Volodymyr Pavlyshyn",
    createdAt: "2026-08-01T10:00:00.000Z",
    body: "Done in rev 2.",
    ...over,
  };
}

describe("threadSignature", () => {
  it("is stable across separately built copies of the same item", () => {
    assert.strictEqual(
      threadSignature(item({ replies: [reply()] })),
      threadSignature(item({ replies: [reply()] }))
    );
  });

  it("ignores everything the posts do not render", () => {
    const base = item();
    // Re-mapping moves the thread and rewrites its header; neither changes a
    // single word of the conversation, so the widget must not be rebuilt.
    const remapped = item({
      match: { startLine: 74, endLine: 75, score: 0.42, method: "semantic", sourceExcerpt: "…" },
      manualLine: 74,
      resolved: true,
    });
    assert.strictEqual(threadSignature(base), threadSignature(remapped));
  });

  it("changes when a reply is added, edited, or removed", () => {
    const none = threadSignature(item());
    const one = threadSignature(item({ replies: [reply()] }));
    const edited = threadSignature(item({ replies: [reply({ body: "Rewritten." })] }));
    const two = threadSignature(item({ replies: [reply(), reply({ id: "r2" })] }));
    assert.strictEqual(new Set([none, one, edited, two]).size, 4);
  });

  it("changes when the mark itself changes", () => {
    assert.notStrictEqual(
      threadSignature(item()),
      threadSignature(item({ comment: "Cut it." }))
    );
    assert.notStrictEqual(
      threadSignature(item()),
      threadSignature(item({ author: "Sam" }))
    );
  });
});

describe("rootMarkdown", () => {
  it("quotes the marked text on one line, above the note", () => {
    assert.strictEqual(
      rootMarkdown(item()),
      "> Two debts from earlier chapters come due here.\n\nTighten this."
    );
  });

  it("prefers the text as marked in the PDF over the anchored source text", () => {
    const md = rootMarkdown(item({ markedText: "come due here" }));
    assert.ok(md.startsWith("> come due here\n\n"));
  });

  it("stands in for a mark with no note", () => {
    assert.strictEqual(
      rootMarkdown(item({ comment: "", anchoredText: "" })),
      "_Highlight with no note._"
    );
  });

  it("caps a runaway quote", () => {
    const md = rootMarkdown(item({ markedText: "x".repeat(900), comment: "n" }));
    assert.strictEqual(md, `> ${"x".repeat(400)}\n\nn`);
  });
});

describe("markAuthor", () => {
  it("falls back to the role when the PDF names nobody", () => {
    assert.strictEqual(markAuthor(item({ author: "" })), "Editor");
    assert.strictEqual(markAuthor(item()), "Rachel");
  });
});

describe("threadLabel", () => {
  it("reports kind, page, confidence and reply count", () => {
    assert.strictEqual(threadLabel(item()), "Highlight · p3 · 0.87");
    assert.strictEqual(
      threadLabel(item({ replies: [reply()] })),
      "Highlight · p3 · 0.87 · 1 reply"
    );
    assert.strictEqual(
      threadLabel(item({ replies: [reply(), reply({ id: "r2" })] })),
      "Highlight · p3 · 0.87 · 2 replies"
    );
  });

  it("names an anchored or hand-placed link instead of a score", () => {
    const anchored = item({
      match: { startLine: 1, endLine: 1, score: 1, method: "marker", sourceExcerpt: "" },
    });
    assert.strictEqual(threadLabel(anchored), "Highlight · p3 · anchored · marker");
    assert.strictEqual(threadLabel(item({ manualLine: 12 })), "Highlight · p3 · manual");
  });
});
