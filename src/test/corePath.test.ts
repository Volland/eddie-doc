import * as assert from "node:assert";
import * as nodePath from "node:path";
import * as p from "../core/util/path.js";

// @lat: [[tests#Core utilities#Core path dialect]]
describe("core path (posix dialect)", () => {
  it("agrees with node:path.posix on ordinary paths", () => {
    const cases: [string, string][] = [
      ["/a/b/c.adoc", "/a/d/e.pdf"],
      ["/a/b", "/a/b/c/d"],
      ["/a/b/c", "/a/b"],
      ["/a", "/a"],
      ["/a/b", "/x/y"],
    ];
    for (const [a, b] of cases) {
      assert.strictEqual(p.relative(a, b), nodePath.posix.relative(a, b), `${a} -> ${b}`);
    }
    for (const x of ["/a/b/c.adoc", "a/b/c.adoc", "/c.adoc", "c.adoc", "/a/b/"]) {
      assert.strictEqual(p.basename(x), nodePath.posix.basename(x), x);
      assert.strictEqual(p.extname(x), nodePath.posix.extname(x), x);
    }
    assert.strictEqual(p.dirname("/a/b/c.adoc"), "/a/b");
    assert.strictEqual(p.dirname("c.adoc"), ".");
    assert.strictEqual(p.dirname("/c.adoc"), "/");
  });

  it("joins and normalizes", () => {
    assert.strictEqual(p.join("a", "b", "../c"), "a/c");
    assert.strictEqual(p.join("/a/b", "..", "c"), "/a/c");
    assert.strictEqual(p.join("a", "/abs"), "/abs");
    assert.strictEqual(p.join("a//b/./c"), "a/b/c");
    assert.strictEqual(p.normalize("../x"), "../x");
    assert.strictEqual(p.normalize(""), ".");
  });

  it("treats a drive letter as absolute and converts backslashes", () => {
    assert.ok(p.isAbsolute("C:/Users/me/ch1.adoc"));
    assert.ok(!p.isAbsolute("Users/me"));
    assert.strictEqual(p.toPosix("C:\\Users\\me\\ch1.adoc"), "C:/Users/me/ch1.adoc");
    assert.strictEqual(p.dirname("C:/Users/me/ch1.adoc"), "C:/Users/me");
    assert.strictEqual(p.dirname("C:/ch1.adoc"), "C:/");
    assert.strictEqual(p.relative("C:/Users/me", "C:/Users/me/book/ch1.adoc"), "book/ch1.adoc");
    assert.strictEqual(p.normalize("C:/a/../b"), "C:/b");
  });

  it("strips a known extension from basename", () => {
    assert.strictEqual(p.basename("x/chapter.adoc", ".adoc"), "chapter");
    assert.strictEqual(p.basename("x/.adoc", ".adoc"), ".adoc");
  });
});
