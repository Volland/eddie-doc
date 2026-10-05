import * as assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { sha256Bytes, sha256Text } from "../core/util/sha256.js";

const ref = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

// @lat: [[tests#Core utilities#Sha256 matches node crypto]]
describe("sha256", () => {
  it("matches node:crypto on the empty input", () => {
    assert.strictEqual(sha256Bytes(new Uint8Array()), ref(""));
    assert.strictEqual(
      sha256Bytes(new Uint8Array()),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("matches node:crypto at every padding boundary", () => {
    // 55/56/63/64 bytes straddle the one-block / two-block padding cases.
    for (const n of [1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const b = new Uint8Array(randomBytes(n));
      assert.strictEqual(sha256Bytes(b), ref(b), `length ${n}`);
    }
  });

  it("hashes text as UTF-8", () => {
    for (const s of ["abc", "naïve café — “quoted”", "日本語のテキスト", "😀 emoji"]) {
      assert.strictEqual(sha256Text(s), ref(s), s);
    }
  });

  it("matches on a multi-megabyte input and does not mutate it", () => {
    const b = new Uint8Array(randomBytes(3 * 1024 * 1024 + 7));
    const copy = new Uint8Array(b);
    assert.strictEqual(sha256Bytes(b), ref(b));
    assert.deepStrictEqual(b, copy);
  });
});
