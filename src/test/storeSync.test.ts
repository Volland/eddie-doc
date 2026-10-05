import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { MemoryStorage } from "../core/host/memoryStorage.js";
import { ReviewStore } from "../core/model/store.js";
import { testHost } from "./testHost.js";

const SAMPLE_PDF = new Uint8Array(readFileSync(nodePath.resolve("sample/chapter-01.annotated.pdf")));
const SAMPLE_ADOC = readFileSync(nodePath.resolve("sample/chapter-01.adoc"), "utf8");
const ADOC = "Manuscript/chapter-01.adoc";
const PDF = "Inbox/chapter-01.annotated.pdf";

/** One device: its own store over the vault they all share. */
function device(storage: MemoryStorage) {
  const ctx = testHost({ storage, settings: { reviewFolder: "Eddie Reviews" } });
  const store = new ReviewStore(ctx.host);
  store.configure({ workspaceRoot: "", reviewFolder: "Eddie Reviews" });
  return { store, ...ctx };
}

// @lat: [[tests#Review store#Changes from another device]]
describe("review store: changes from another device", function () {
  this.timeout(30000);
  let vault: MemoryStorage;
  let sidecar: string;

  beforeEach(async () => {
    vault = new MemoryStorage();
    await vault.writeText(ADOC, SAMPLE_ADOC);
    await vault.writeBytes(PDF, SAMPLE_PDF);
    const a = device(vault);
    const s = await a.store.loadReview(ADOC, PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      importPdf: true,
    });
    await a.store.flush();
    sidecar = s.sidecarPath;
    a.store.dispose();
  });

  it("recognises the echo of its own write and does not reload", async () => {
    const a = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    const id = a.store.get(ADOC)!.items[0].id;
    a.store.toggleResolved(ADOC, id);
    await a.store.flush();
    let events = 0;
    a.store.onDidChange(() => events++);
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "unchanged");
    assert.strictEqual(events, 0);
  });

  it("picks up a reply another device wrote", async () => {
    const a = device(vault);
    const b = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    await b.store.tryLoadSidecar(ADOC);
    const id = b.store.get(ADOC)!.items[0].id;
    b.store.addReply(ADOC, id, "Pat", "from the phone");
    await b.store.flush();

    let events = 0;
    a.store.onDidChange(() => events++);
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "reloaded");
    assert.strictEqual(a.store.findItem(ADOC, id)?.replies?.[0].body, "from the phone");
    assert.strictEqual(events, 1);
  });

  it("merges instead of overwriting when both devices replied, and keeps the other copy", async () => {
    const a = device(vault);
    const b = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    await b.store.tryLoadSidecar(ADOC);
    const id = a.store.get(ADOC)!.items[0].id;

    b.store.addReply(ADOC, id, "Pat", "reply from b");
    await b.store.flush();
    // a has not seen b's write yet, and replies too.
    a.store.addReply(ADOC, id, "Sam", "reply from a");
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "pending", "left for the write to reconcile");
    await a.store.flush();

    const bodies = a.store.findItem(ADOC, id)!.replies!.map((r) => r.body).sort();
    assert.deepStrictEqual(bodies, ["reply from a", "reply from b"]);
    // What is on disk now holds both, so a third device sees both.
    const c = device(vault);
    await c.store.tryLoadSidecar(ADOC);
    assert.strictEqual(c.store.findItem(ADOC, id)!.replies!.length, 2);
    // The other copy was kept, and the author was told.
    const kept = (await vault.list(nodePath.posix.dirname(sidecar))).filter((e) => /\.conflict-/.test(e.name));
    assert.strictEqual(kept.length, 1);
    assert.ok(a.shown.warn.some((m) => /changed elsewhere/.test(m) && /merged/.test(m)));
  });

  it("adds annotations only the other device holds", async () => {
    const a = device(vault);
    const b = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    await b.store.tryLoadSidecar(ADOC);
    const extra = { ...b.store.get(ADOC)!.items[0], id: "only-on-b", number: undefined, initials: undefined };
    b.store.get(ADOC)!.items.push(extra);
    b.store.toggleResolved(ADOC, "only-on-b");
    await b.store.flush();

    a.store.toggleResolved(ADOC, a.store.get(ADOC)!.items[0].id);
    await a.store.flush();
    assert.ok(a.store.findItem(ADOC, "only-on-b"), "the other device's annotation survived our write");
  });

  it("forgets a mapping whose file was deleted elsewhere", async () => {
    const a = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    await vault.remove(sidecar);
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "missing");
    assert.strictEqual(a.store.get(ADOC), undefined);
  });

  it("keeps unsaved work when the file disappears, and re-creates the file with it", async () => {
    const a = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    const id = a.store.get(ADOC)!.items[0].id;
    await vault.remove(sidecar); // deleted elsewhere…
    a.store.toggleResolved(ADOC, id); // …while we have an unsaved change queued
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "pending");
    await a.store.flush();
    assert.ok(a.store.get(ADOC), "still loaded");
    assert.ok(await vault.exists(sidecar), "written back with the unsaved change");
  });

  it("loads a sidecar that appeared from another device", async () => {
    const a = device(vault);
    assert.strictEqual(a.store.get(ADOC), undefined);
    assert.strictEqual(await a.store.reloadFromDisk(sidecar), "reloaded");
    assert.ok(a.store.get(ADOC));
  });

  it("follows a renamed manuscript and rewrites the sidecar's recorded path", async () => {
    const a = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    // The user renames the file in the vault…
    await vault.writeText("Manuscript/ch1.adoc", SAMPLE_ADOC);
    await vault.remove(ADOC);
    // …and the plugin is told.
    assert.strictEqual(a.store.rebindPaths(ADOC, "Manuscript/ch1.adoc"), 1);
    await a.store.flush();
    assert.ok(a.store.get("Manuscript/ch1.adoc"), "the review is now found under the new name");
    assert.strictEqual(a.store.get(ADOC), undefined);

    // A fresh device, knowing only the files, binds to the renamed manuscript.
    const b = device(vault);
    assert.ok(await b.store.loadSidecarFile(sidecar));
    assert.strictEqual(b.store.getBySidecar(sidecar)!.adocPath, "Manuscript/ch1.adoc");
  });

  it("follows a renamed folder, a renamed PDF and a moved sidecar", async () => {
    const a = device(vault);
    await a.store.tryLoadSidecar(ADOC);
    const s = a.store.get(ADOC)!;
    const pdf = s.pdfPath;

    assert.strictEqual(a.store.rebindPaths("Manuscript", "Book"), 1);
    assert.strictEqual(a.store.get("Book/chapter-01.adoc")?.adocPath, "Book/chapter-01.adoc");

    const copied = pdf.replace("chapter-01.pdf", "renamed.pdf");
    assert.strictEqual(a.store.rebindPaths(pdf, copied), 1);
    assert.strictEqual(a.store.get("Book/chapter-01.adoc")!.pdfPath, copied);

    const moved = sidecar.replace("Eddie Reviews/", "Eddie Reviews/archive/");
    assert.strictEqual(a.store.rebindPaths(sidecar, moved), 1);
    assert.ok(a.store.getBySidecar(moved));
    assert.strictEqual(a.store.getBySidecar(sidecar), undefined);
    assert.strictEqual(a.store.get("Book/chapter-01.adoc")!.sidecarPath, moved, "still the shown mapping");

    assert.strictEqual(a.store.rebindPaths("Elsewhere", "Nowhere"), 0, "unrelated renames change nothing");
  });
});
