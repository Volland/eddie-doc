import * as assert from "node:assert";
import { MemoryStorage } from "../core/host/memoryStorage.js";

// @lat: [[tests#Core utilities#Memory storage]]
describe("MemoryStorage", () => {
  it("round-trips text and bytes and creates implied folders", async () => {
    const s = new MemoryStorage();
    await s.writeText("a/b/c.txt", "héllo");
    await s.writeBytes("a/b/d.bin", new Uint8Array([1, 2, 3]));
    assert.strictEqual(await s.readText("a/b/c.txt"), "héllo");
    assert.deepStrictEqual([...(await s.readBytes("a/b/d.bin"))], [1, 2, 3]);
    assert.ok(await s.exists("a/b"));
    assert.ok(await s.exists("a"));
    assert.ok(!(await s.exists("a/x")));
  });

  it("returns copies, so callers cannot corrupt stored bytes", async () => {
    const s = new MemoryStorage({ "f.bin": new Uint8Array([9, 9]) });
    (await s.readBytes("f.bin"))[0] = 0;
    assert.deepStrictEqual([...(await s.readBytes("f.bin"))], [9, 9]);
  });

  it("lists direct children, flagging folders; missing dir is empty", async () => {
    const s = new MemoryStorage({ "r/rev-1/x.json": "{}", "r/rev-2/y.json": "{}", "r/top.txt": "" });
    const l = (await s.list("r")).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepStrictEqual(l, [
      { name: "rev-1", isDirectory: true },
      { name: "rev-2", isDirectory: true },
      { name: "top.txt", isDirectory: false },
    ]);
    assert.deepStrictEqual(await s.list("nope"), []);
  });

  it("removes quietly, copies, and rejects reading a missing file", async () => {
    const s = new MemoryStorage({ "a.txt": "x" });
    await s.copy("a.txt", "deep/er/b.txt");
    assert.strictEqual(await s.readText("deep/er/b.txt"), "x");
    await s.remove("a.txt");
    await s.remove("a.txt");
    assert.ok(!(await s.exists("a.txt")));
    await assert.rejects(s.readText("a.txt"), /ENOENT/);
  });
});
