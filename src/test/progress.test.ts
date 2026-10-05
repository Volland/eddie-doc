import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { CancelledError, isCancelled, setUiScheduler, timeSlicer } from "../core/host/progress.js";
import { extractAnnotations, readPages } from "../core/pdf/extract.js";
import { readPageGeometry } from "../core/pdf/pageGeometry.js";

const PDF = new Uint8Array(readFileSync(nodePath.resolve("sample/chapter-01.annotated.pdf")));

// @lat: [[tests#PDF reading#Progress and cancellation]]
describe("progress and cancellation", function () {
  this.timeout(30000);

  it("reports every page, in order, with the total", async () => {
    const seen: [number, number, string | undefined][] = [];
    await extractAnnotations(PDF, { report: (d, t, l) => seen.push([d, t, l]) });
    assert.deepStrictEqual(seen, [1, 2, 3, 4, 5].map((n) => [n, 5, "page"]));
  });

  it("stops at the next page once aborted, rejecting with a recognisable error", async () => {
    const ctl = new AbortController();
    const seen: number[] = [];
    await assert.rejects(
      readPages(PDF, {
        signal: ctl.signal,
        report: (d) => {
          seen.push(d);
          if (d === 2) ctl.abort();
        },
      }),
      (e) => e instanceof CancelledError && isCancelled(e)
    );
    assert.deepStrictEqual(seen, [1, 2], "no page after the abort was read");
  });

  it("does not start at all if already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const seen: number[] = [];
    await assert.rejects(
      extractAnnotations(PDF, { signal: ctl.signal, report: (d) => seen.push(d) }),
      CancelledError
    );
    assert.deepStrictEqual(seen, []);
  });

  it("yields only once its time budget is spent", async () => {
    let clock = 0;
    let yields = 0;
    setUiScheduler((run) => {
      yields++;
      setTimeout(run, 0);
    });
    try {
      const s = timeSlicer(24, () => clock);
      await s.tick(); // 0ms spent
      clock = 23;
      await s.tick();
      assert.strictEqual(yields, 0, "under budget: no yield");
      clock = 24;
      await s.tick();
      assert.strictEqual(yields, 1, "at budget: yields");
      clock = 30;
      await s.tick();
      assert.strictEqual(yields, 1, "budget restarts after a yield");
    } finally {
      setUiScheduler();
    }
  });

  it("reads a page's box and rotation, and reports a missing page as undefined", async () => {
    const g = await readPageGeometry(PDF, 1);
    assert.ok(g);
    assert.strictEqual(g!.rotate, 0);
    assert.ok(g!.view[2] > g!.view[0] && g!.view[3] > g!.view[1], "a real page box");
    assert.strictEqual(await readPageGeometry(PDF, 99), undefined);
    assert.strictEqual(await readPageGeometry(new Uint8Array([1, 2, 3]), 1), undefined);
  });
});
