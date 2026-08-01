import * as assert from "node:assert";
import {
  buildBlocks,
  semanticFallback,
  MemoryEmbedCache,
  type FetchLike,
} from "../matching/semantic.js";
import type { ReviewItem } from "../model/types.js";

describe("buildBlocks", () => {
  it("splits prose into paragraph blocks with line ranges", () => {
    const blocks = buildBlocks(
      ["= Title", "", "First paragraph line one,", "line two.", "", "Second."].join(
        "\n"
      )
    );
    assert.strictEqual(blocks.length, 3); // title, first para, second para
    assert.deepStrictEqual(
      blocks.map((b) => [b.startLine, b.endLine]),
      [
        [0, 0],
        [2, 3],
        [5, 5],
      ]
    );
  });

  it("skips //// comment blocks and // line comments", () => {
    const blocks = buildBlocks(
      [
        "Visible paragraph.", // 0
        "", // 1
        "////", // 2
        "Hidden editorial note that reads like prose.", // 3
        "////", // 4
        "// hidden line comment", // 5
        "Another visible paragraph.", // 6
      ].join("\n")
    );
    assert.deepStrictEqual(
      blocks.map((b) => b.text),
      ["Visible paragraph.", "Another visible paragraph."]
    );
  });
});

// ---------------------------------------------------------------------------
// semanticFallback against a faked Ollama backend
// ---------------------------------------------------------------------------

const SOURCE = [
  "First paragraph is all about apples and orchards.",
  "",
  "Second paragraph is all about boats and harbors.",
].join("\n");

/** Deterministic stand-in embeddings: apples → x-axis, boats → y-axis. */
function vecFor(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes("apple") || t.includes("fruit")) return [1, 0.1];
  if (t.includes("boat") || t.includes("ship")) return [0.1, 1];
  return [0.5, 0.5];
}

interface Call {
  url: string;
  body: { input?: string[]; prompt?: string };
}

/** Fake backend: `batched` controls whether /api/embed exists. */
function fakeOllama(batched: boolean): { calls: Call[]; fetchFn: FetchLike } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Call["body"];
    calls.push({ url, body });
    if (url.endsWith("/api/embed")) {
      if (!batched) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: (body.input ?? []).map(vecFor) }),
      };
    }
    if (url.endsWith("/api/embeddings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: vecFor(body.prompt ?? "") }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchFn };
}

function unmatchedItem(text: string): ReviewItem {
  return {
    id: `it-${text.slice(0, 8)}`,
    kind: "comment",
    page: 1,
    comment: text,
    anchoredText: "",
    rect: [0, 0, 0, 0],
    match: null,
    resolved: false,
  };
}

const OPTS = { url: "http://fake:1", model: "m", threshold: 0.5 };

describe("semanticFallback", () => {
  it("links paraphrased anchors to the nearest paragraph in one batched call", async () => {
    const { calls, fetchFn } = fakeOllama(true);
    const item = unmatchedItem("consider mentioning fruit varieties here");
    const res = await semanticFallback([item], SOURCE, { ...OPTS, fetchFn });

    assert.deepStrictEqual(res, { applied: 1, ok: true });
    assert.strictEqual(item.match?.method, "semantic");
    assert.strictEqual(item.match?.startLine, 0); // the apples paragraph
    // 2 paragraphs + 1 query, all in a single /api/embed round-trip.
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.input?.length, 3);
  });

  it("serves repeat runs from the cache without calling the backend", async () => {
    const { calls, fetchFn } = fakeOllama(true);
    const cache = new MemoryEmbedCache();

    await semanticFallback(
      [unmatchedItem("consider mentioning fruit varieties here")],
      SOURCE,
      { ...OPTS, fetchFn, cache }
    );
    const callsAfterFirst = calls.length;

    const second = unmatchedItem("consider mentioning fruit varieties here");
    const res = await semanticFallback([second], SOURCE, {
      ...OPTS,
      fetchFn,
      cache,
    });
    assert.strictEqual(res.applied, 1);
    assert.strictEqual(second.match?.startLine, 0);
    assert.strictEqual(calls.length, callsAfterFirst); // no new requests
  });

  it("falls back to the legacy per-input endpoint when /api/embed is absent", async () => {
    const { calls, fetchFn } = fakeOllama(false);
    const item = unmatchedItem("a remark about ships and sails");
    const res = await semanticFallback([item], SOURCE, { ...OPTS, fetchFn });

    assert.deepStrictEqual(res, { applied: 1, ok: true });
    assert.strictEqual(item.match?.startLine, 2); // the boats paragraph
    assert.ok(calls.some((c) => c.url.endsWith("/api/embeddings")));
  });

  it("reports ok:false and touches nothing when the backend is unreachable", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const item = unmatchedItem("anything at all");
    const res = await semanticFallback([item], SOURCE, { ...OPTS, fetchFn });
    assert.deepStrictEqual(res, { applied: 0, ok: false });
    assert.strictEqual(item.match, null);
  });

  it("leaves already-matched and manually-linked items alone", async () => {
    const { calls, fetchFn } = fakeOllama(true);
    const matched = unmatchedItem("about apples");
    matched.match = {
      startLine: 0,
      endLine: 0,
      score: 0.9,
      sourceExcerpt: "x",
    };
    const manual = unmatchedItem("about boats");
    manual.manualLine = 2;
    const res = await semanticFallback([matched, manual], SOURCE, {
      ...OPTS,
      fetchFn,
    });
    assert.deepStrictEqual(res, { applied: 0, ok: true });
    assert.strictEqual(calls.length, 0);
  });
});
