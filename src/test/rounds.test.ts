import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewStore } from "../model/store.js";

/**
 * The multi-round workflow end to end, against the real sample PDF: map a round,
 * work on it, take another editor's PDF into the same round, then start the next
 * round and check that the author's work came with them.
 */
const SAMPLE_PDF = path.resolve("sample/chapter-01.annotated.pdf");
const SAMPLE_ADOC = path.resolve("sample/chapter-01.adoc");

let root: string;
let adocPath: string;
let store: ReviewStore;

describe("review rounds, end to end", function () {
  // Each round re-parses the PDF; generous but still fast in practice.
  this.timeout(30000);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eddie-rounds-"));
    fs.mkdirSync(path.join(root, "manuscript"), { recursive: true });
    adocPath = path.join(root, "manuscript", "chapter-01.adoc");
    fs.copyFileSync(SAMPLE_ADOC, adocPath);
    store = new ReviewStore();
    store.configure({ workspaceRoot: root, reviewFolder: ".eddie" });
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the manuscript folder clean while building the round tree", async () => {
    await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Acme Editorial" },
    });

    assert.deepStrictEqual(fs.readdirSync(path.join(root, "manuscript")), [
      "chapter-01.adoc",
    ]);
    const revDir = path.join(
      root,
      ".eddie",
      "manuscript",
      "chapter-01",
      "rev-1"
    );
    assert.deepStrictEqual(fs.readdirSync(revDir), ["chapter-01.review.json"]);
  });

  it("carries resolved state, notes and replies into the next round", async () => {
    const first = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Acme Editorial" },
    });
    assert.ok(first.items.length >= 2, "sample PDF should carry annotations");

    const target = first.items[0].id;
    store.toggleResolved(adocPath, target);
    store.addReply(adocPath, target, "Author", "Rewrote the paragraph.");
    assert.strictEqual(store.findItem(adocPath, target)?.resolved, true);

    const second = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: store.nextRevision(adocPath),
      mapping: { origin: "Acme Editorial" },
    });

    assert.strictEqual(second.revision.ordinal, 2);
    const carried = second.items.find((i) => i.id === target);
    assert.ok(carried, "the annotation should still be there in round 2");
    assert.strictEqual(carried!.resolved, true, "resolved state should carry");
    assert.strictEqual(carried!.replies?.[0]?.body, "Rewrote the paragraph.");

    // Round 1 is untouched by round 2 — its own record of the pass survives.
    const round1 = store
      .sessionsFor(adocPath)
      .find((s) => s.revision.ordinal === 1);
    assert.strictEqual(round1?.items.find((i) => i.id === target)?.resolved, true);
    assert.strictEqual(store.sessionsFor(adocPath).length, 2);
  });

  it("keeps two editors' marks on one round apart", async () => {
    await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Acme Editorial" },
    });
    // A second site returns the same round; the id is derived from the PDF, so
    // give it its own file name to stand in for a differently-named delivery.
    const second = path.join(root, "in", "beta-proofread.pdf");
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.copyFileSync(SAMPLE_PDF, second);

    const beta = await store.loadReview(adocPath, second, {
      threshold: 0.5,
      revision: store.latestRevision(adocPath)!,
      mapping: { origin: "Beta Proofing" },
    });

    assert.strictEqual(beta.revision.ordinal, 1);
    assert.strictEqual(beta.mapping.id, "beta-proofread");
    assert.strictEqual(store.sessionsFor(adocPath).length, 2);
    assert.strictEqual(store.revisionsFor(adocPath).length, 1);

    // Resolving in one mapping leaves the other editor's copy open.
    const id = beta.items[0].id;
    store.setActive(beta.sidecarPath);
    store.toggleResolved(adocPath, id);
    const acme = store
      .sessionsFor(adocPath)
      .find((s) => s.mapping.id === "chapter-01");
    assert.strictEqual(acme?.items.find((i) => i.id === id)?.resolved, false);
  });

  it("carries from the same editor's earlier pass, not just the latest file", async () => {
    // Round 1 from two places; Acme's copy is the older of the two.
    const acme1 = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Acme Editorial" },
    });
    const betaPdf = path.join(root, "in", "beta.pdf");
    fs.mkdirSync(path.dirname(betaPdf), { recursive: true });
    fs.copyFileSync(SAMPLE_PDF, betaPdf);
    await store.loadReview(adocPath, betaPdf, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Beta Proofing" },
    });

    // Only Acme's mapping records this decision.
    const id = acme1.items[0].id;
    store.setActive(acme1.sidecarPath);
    store.toggleResolved(adocPath, id);

    // Round 2 from Acme should inherit Acme's round-1 state.
    const acme2 = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: store.nextRevision(adocPath),
      mapping: { origin: "Acme Editorial" },
    });
    assert.strictEqual(
      acme2.items.find((i) => i.id === id)?.resolved,
      true,
      "round 2 should inherit the same editor's earlier pass"
    );
  });

  it("keeps a mapping's metadata when the same PDF is re-mapped", async () => {
    const first = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      mapping: { origin: "Acme Editorial", reviewType: "copyedit" },
    });
    store.describeMapping(first.sidecarPath, {
      revision: { label: "First pass" },
      reviewer: "R. Hale",
    });

    // Re-opening the same PDF with nothing new to say must not blank the record.
    const again = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      sidecarPath: first.sidecarPath,
      mapping: {},
    });

    assert.strictEqual(again.sidecarPath, first.sidecarPath);
    assert.strictEqual(again.mapping.origin, "Acme Editorial");
    assert.strictEqual(again.mapping.reviewer, "R. Hale");
    assert.strictEqual(again.mapping.reviewType, "copyedit");
    assert.strictEqual(store.sessionsFor(adocPath).length, 1);
  });

  it("imports the PDF beside its mapping when asked", async () => {
    const session = await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
      importPdf: true,
    });
    const expected = path.join(
      root,
      ".eddie",
      "manuscript",
      "chapter-01",
      "rev-1",
      "pdf",
      "chapter-01.pdf"
    );
    assert.strictEqual(session.pdfPath, expected);
    assert.strictEqual(fs.existsSync(expected), true);
    assert.strictEqual(session.pdf.imported, true);
    assert.strictEqual(session.pdf.importedFrom, SAMPLE_PDF);
    // The original is left where it was.
    assert.strictEqual(fs.existsSync(SAMPLE_PDF), true);
  });

  it("re-maps every round of a document when the source changes", async () => {
    await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: { id: "rev-1", ordinal: 1 },
    });
    await store.loadReview(adocPath, SAMPLE_PDF, {
      threshold: 0.5,
      revision: store.nextRevision(adocPath),
    });
    // Push every line down; a re-map must re-derive positions for both rounds.
    fs.writeFileSync(
      adocPath,
      "// added\n\n" + fs.readFileSync(adocPath, "utf8"),
      "utf8"
    );
    const n = await store.remapAll(adocPath, 0.5);
    assert.strictEqual(n, 2);
    for (const s of store.sessionsFor(adocPath)) {
      assert.strictEqual(s.version, 3);
      assert.ok(s.integrity?.sourceSha256, "each round re-fingerprints the source");
    }
  });
});
