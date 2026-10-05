import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { MemoryStorage } from "../core/host/memoryStorage.js";
import { Emitter } from "../core/host/services.js";
import type { Storage } from "../core/host/storage.js";
import { documentFolder, mappingSidecarPath, reviewRoot } from "../core/model/layout.js";
import { NodeStorage } from "../hosts/node/nodeStorage.js";

/** What every Storage must do, run against each implementation. */
function contract(name: string, make: () => { storage: Storage; cleanup(): void }) {
  describe(`storage contract: ${name}`, () => {
    let s: Storage;
    let cleanup: () => void;
    beforeEach(() => ({ storage: s, cleanup } = make()));
    afterEach(() => cleanup());

    it("writes create parent folders and round-trip text and bytes", async () => {
      await s.writeText("a/b/c.txt", "héllo — ünïcode");
      await s.writeBytes("a/b/d.bin", new Uint8Array([0, 1, 254, 255]));
      assert.strictEqual(await s.readText("a/b/c.txt"), "héllo — ünïcode");
      assert.deepStrictEqual([...(await s.readBytes("a/b/d.bin"))], [0, 1, 254, 255]);
    });

    it("overwrites an existing file", async () => {
      await s.writeText("f.txt", "one");
      await s.writeText("f.txt", "two");
      assert.strictEqual(await s.readText("f.txt"), "two");
    });

    it("exists is true for files and folders, false otherwise, and never rejects", async () => {
      await s.writeText("d/f.txt", "x");
      assert.ok(await s.exists("d/f.txt"));
      assert.ok(await s.exists("d"));
      assert.ok(!(await s.exists("d/nope.txt")));
      assert.ok(!(await s.exists("nowhere/at/all")));
    });

    it("rejects reading a missing file", async () => {
      await assert.rejects(s.readText("missing.txt"));
      await assert.rejects(s.readBytes("missing.bin"));
    });

    it("remove deletes a file and is quiet about one that is already gone", async () => {
      await s.writeText("x.txt", "x");
      await s.remove("x.txt");
      await s.remove("x.txt");
      assert.ok(!(await s.exists("x.txt")));
    });

    it("copy duplicates a file and creates the target's folders", async () => {
      await s.writeBytes("src.bin", new Uint8Array([7, 8, 9]));
      await s.copy("src.bin", "deep/er/dst.bin");
      assert.deepStrictEqual([...(await s.readBytes("deep/er/dst.bin"))], [7, 8, 9]);
      assert.ok(await s.exists("src.bin"), "the source is kept");
    });

    it("list returns direct children, flags folders, and is empty for a missing folder", async () => {
      await s.writeText("r/rev-1/x.json", "{}");
      await s.writeText("r/rev-2/y.json", "{}");
      await s.writeText("r/top.txt", "");
      const l = (await s.list("r")).sort((a, b) => a.name.localeCompare(b.name));
      assert.deepStrictEqual(l, [
        { name: "rev-1", isDirectory: true },
        { name: "rev-2", isDirectory: true },
        { name: "top.txt", isDirectory: false },
      ]);
      assert.deepStrictEqual(await s.list("not/there"), []);
    });

    it("returns bytes the caller can change without affecting the stored file", async () => {
      await s.writeBytes("b.bin", new Uint8Array([1, 2, 3]));
      (await s.readBytes("b.bin"))[0] = 99;
      assert.deepStrictEqual([...(await s.readBytes("b.bin"))], [1, 2, 3]);
    });
  });
}

// @lat: [[tests#Core utilities#Storage contract]]
contract("MemoryStorage", () => ({ storage: new MemoryStorage(), cleanup: () => undefined }));
contract("NodeStorage", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "eddie-contract-"));
  return { storage: new NodeStorage(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
});

// @lat: [[tests#Core utilities#Event emitter]]
describe("Emitter", () => {
  it("delivers to every listener, in order, and stops after dispose", () => {
    const e = new Emitter<number>();
    const seen: string[] = [];
    const a = e.event((v) => seen.push(`a${v}`));
    e.event((v) => seen.push(`b${v}`));
    e.fire(1);
    a.dispose();
    e.fire(2);
    assert.deepStrictEqual(seen, ["a1", "b1", "b2"]);
  });

  it("isolates a listener that throws from the rest", () => {
    const e = new Emitter<void>();
    let reached = false;
    e.event(() => {
      throw new Error("boom");
    });
    e.event(() => {
      reached = true;
    });
    assert.doesNotThrow(() => e.fire());
    assert.ok(reached);
  });

  it("clears every listener on dispose", () => {
    const e = new Emitter<void>();
    let n = 0;
    e.event(() => n++);
    e.dispose();
    e.fire();
    assert.strictEqual(n, 0);
  });
});

// @lat: [[tests#Core utilities#Layout with an empty root]]
describe("layout with a vault-relative root", () => {
  it("treats an empty workspace root as a real root, not as missing", () => {
    const cfg = { workspaceRoot: "", reviewFolder: "Eddie Reviews" };
    assert.strictEqual(reviewRoot(cfg, "Manuscript/ch.adoc"), "Eddie Reviews");
    const folder = documentFolder(cfg, "Manuscript/Part 1/chapter-01.adoc");
    assert.strictEqual(folder, "Eddie Reviews/Manuscript/Part 1/chapter-01");
    assert.strictEqual(
      mappingSidecarPath(folder!, "rev-2", "acme"),
      "Eddie Reviews/Manuscript/Part 1/chapter-01/rev-2/acme.review.json"
    );
  });

  it("still falls back to the legacy layout when the review folder is empty", () => {
    assert.strictEqual(reviewRoot({ workspaceRoot: "", reviewFolder: "" }, "a.adoc"), undefined);
  });

  it("mirrors a root-level manuscript without a stray separator", () => {
    const folder = documentFolder({ workspaceRoot: "", reviewFolder: "R" }, "chapter.adoc");
    assert.strictEqual(folder, "R/chapter");
  });
});
