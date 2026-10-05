import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { MemoryStorage } from "../core/host/memoryStorage.js";
import type { DirEntry, Storage } from "../core/host/storage.js";
import { ReviewStore } from "../core/model/store.js";
import { testHost } from "./testHost.js";

/**
 * The store on a storage that is not a disk: the contract an Obsidian vault
 * adapter must meet. Paths are workspace-relative — there is no absolute path on
 * mobile — and the vault root is the empty string.
 */
const SAMPLE_PDF = new Uint8Array(
  readFileSync(nodePath.resolve("sample/chapter-01.annotated.pdf"))
);
const SAMPLE_ADOC = readFileSync(nodePath.resolve("sample/chapter-01.adoc"), "utf8");

const ADOC = "Manuscript/chapter-01.adoc";
const PDF = "Inbox/chapter-01.annotated.pdf";

/** MemoryStorage that counts what is written, per path. */
class CountingStorage extends MemoryStorage {
  writes: string[] = [];
  override async writeText(path: string, text: string): Promise<void> {
    this.writes.push(path);
    return super.writeText(path, text);
  }
}

function vault(storage: Storage = new CountingStorage()) {
  const ctx = testHost({ storage, settings: { reviewFolder: "Eddie Reviews" } });
  const store = new ReviewStore(ctx.host);
  store.configure({ workspaceRoot: "", reviewFolder: "Eddie Reviews" });
  return { store, storage, ...ctx };
}

// @lat: [[tests#Review store#Vault-style storage]]
describe("review store on a vault-style storage", function () {
  this.timeout(30000);

  let storage: CountingStorage;
  beforeEach(async () => {
    storage = new CountingStorage();
    await storage.writeText(ADOC, SAMPLE_ADOC);
    await storage.writeBytes(PDF, SAMPLE_PDF);
  });

  it("maps a PDF using only relative paths and keeps the vault tidy", async () => {
    const { store } = vault(storage);
    const s = await store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      importPdf: true,
    });
    await store.flush();

    assert.ok(s.items.length >= 2, "the sample PDF carries annotations");
    assert.strictEqual(
      s.sidecarPath,
      "Eddie Reviews/Manuscript/chapter-01/rev-1/chapter-01.review.json"
    );
    // The PDF was copied in beside its mapping, so the round is self-contained.
    assert.ok(await storage.exists("Eddie Reviews/Manuscript/chapter-01/rev-1/pdf/chapter-01.pdf"));
    // Nothing was written beside the manuscript.
    assert.deepStrictEqual(
      (await storage.list("Manuscript")).map((e: DirEntry) => e.name),
      ["chapter-01.adoc"]
    );
    store.dispose();
  });

  it("reloads the same review from the sidecar alone, on a fresh store", async () => {
    const a = vault(storage);
    const first = await a.store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      importPdf: true,
    });
    const target = first.items[0].id;
    a.store.toggleResolved(ADOC, target);
    a.store.addReply(ADOC, target, "Author", "Done.");
    await a.store.flush();
    a.store.dispose();

    // A second device opening the same vault: no memory, only the files.
    const b = vault(storage);
    const loaded = await b.store.tryLoadSidecar(ADOC);
    assert.ok(loaded, "discovery found the sidecar under the review folder");
    assert.strictEqual(loaded!.items.length, first.items.length);
    const item = b.store.findItem(ADOC, target)!;
    assert.strictEqual(item.resolved, true);
    assert.strictEqual(item.replies?.[0].body, "Done.");
    // And it still points at the (relative) PDF and source it was made from.
    assert.strictEqual(loaded!.adocPath, ADOC);
    b.store.dispose();
  });

  it("coalesces a burst of edits into one write", async () => {
    const { store } = vault(storage);
    const s = await store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
    });
    await store.flush();
    storage.writes.length = 0;

    for (const it of s.items) store.toggleResolved(ADOC, it.id);
    store.addReply(ADOC, s.items[0].id, "Author", "one");
    store.addReply(ADOC, s.items[0].id, "Author", "two");
    await store.flush();

    assert.strictEqual(
      storage.writes.filter((p) => p === s.sidecarPath).length,
      1,
      "N edits in one tick are one write"
    );
    store.dispose();
  });

  it("does not resurrect a mapping that is deleted while a save is queued", async () => {
    const { store } = vault(storage);
    const s = await store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
    });
    await store.flush();

    store.toggleResolved(ADOC, s.items[0].id); // queues a save…
    assert.strictEqual(await store.deleteMapping(s.sidecarPath), true); // …then it goes
    await store.flush();

    assert.strictEqual(await storage.exists(s.sidecarPath), false);
    store.dispose();
  });

  it("reports a failed save instead of throwing, and keeps the in-memory state", async () => {
    class Failing extends CountingStorage {
      fail = false;
      override async writeText(p: string, t: string): Promise<void> {
        if (this.fail) throw new Error("disk full");
        return super.writeText(p, t);
      }
    }
    const failing = new Failing();
    await failing.writeText(ADOC, SAMPLE_ADOC);
    await failing.writeBytes(PDF, SAMPLE_PDF);
    const { store, shown } = vault(failing);
    const s = await store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
    });
    await store.flush();

    failing.fail = true;
    store.toggleResolved(ADOC, s.items[0].id);
    await store.flush();

    assert.ok(shown.warn.some((m) => /could not save review sidecar: .*disk full/.test(m)));
    assert.strictEqual(store.findItem(ADOC, s.items[0].id)?.resolved, true);
    store.dispose();
  });

  it("turns the semantic fallback off where the host has no localhost", async () => {
    let calls = 0;
    const ctx = testHost({
      storage,
      semantic: false,
      settings: { reviewFolder: "Eddie Reviews", semanticFallback: true },
    });
    ctx.host.fetch = async () => {
      calls++;
      throw new Error("must not be reached");
    };
    const store = new ReviewStore(ctx.host);
    store.configure({ workspaceRoot: "", reviewFolder: "Eddie Reviews" });
    await store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
    });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(ctx.shown.warn, [], "and it does not nag about it either");
    store.dispose();
  });
});
