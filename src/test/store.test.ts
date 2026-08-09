import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewStore } from "../model/store.js";
import { serialize } from "../model/format.js";
import type { ReviewSession } from "../model/types.js";

/**
 * A project on disk: a manuscript folder with real .adoc files, and a review
 * folder we let the store fill in. The store reads and writes real files, so
 * these tests exercise the paths it actually produces rather than a mock of them.
 */
let root: string;
let store: ReviewStore;

function adoc(rel: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "= Chapter\n\nSome prose to match against.\n", "utf8");
  return file;
}

/** Write a sidecar for one mapping, the way the store would, and load it. */
function seed(
  adocPath: string,
  opts: {
    ordinal: number;
    mappingId: string;
    origin?: string;
    updatedAt?: string;
    sidecarPath?: string;
  }
): ReviewSession {
  const revision = { id: `rev-${opts.ordinal}`, ordinal: opts.ordinal };
  const sidecarPath =
    opts.sidecarPath ?? store.sidecarPathFor(adocPath, revision, opts.mappingId);
  const session: ReviewSession = {
    version: 3,
    sidecarPath,
    adocPath,
    pdfPath: path.join(root, "in", `${opts.mappingId}.pdf`),
    revision,
    mapping: {
      id: opts.mappingId,
      kind: "annotations",
      origin: opts.origin,
    },
    pdf: { role: "annotated" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: opts.updatedAt ?? "2026-08-01T00:00:00.000Z",
    items: [],
  };
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, serialize(session, sidecarPath), "utf8");
  const loaded = store.loadSidecarFile(sidecarPath, adocPath);
  assert.ok(loaded, `failed to load seeded sidecar ${sidecarPath}`);
  return loaded!;
}

describe("review store — rounds and mappings", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eddie-store-"));
    store = new ReviewStore();
    store.configure({ workspaceRoot: root, reviewFolder: ".eddie" });
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a mapping into its round's folder, mirroring the manuscript tree", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const sidecar = store.sidecarPathFor(
      file,
      { id: "rev-2", ordinal: 2 },
      "acme-copyedit"
    );
    assert.strictEqual(
      sidecar,
      path.join(
        root,
        ".eddie",
        "manuscript",
        "chapter-01",
        "rev-2",
        "acme-copyedit.review.json"
      )
    );
    // Nothing was written beside the manuscript.
    assert.deepStrictEqual(
      fs.readdirSync(path.join(root, "manuscript")),
      ["chapter-01.adoc"]
    );
  });

  it("falls back to the legacy path when no review folder is configured", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    store.configure({ workspaceRoot: root, reviewFolder: "" });
    assert.strictEqual(
      store.sidecarPathFor(file, { id: "rev-1", ordinal: 1 }, "chapter-01"),
      path.join(root, "manuscript", "chapter-01.review.json")
    );
    // A second round has nowhere of its own to go, so it disambiguates by name
    // rather than overwriting the first.
    const second = store.sidecarPathFor(
      file,
      { id: "rev-2", ordinal: 2 },
      "beta"
    );
    assert.strictEqual(
      path.basename(second),
      "chapter-01.rev-2-beta.review.json"
    );
  });

  it("groups a document's mappings into rounds, oldest first", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    seed(file, { ordinal: 2, mappingId: "beta", origin: "Beta" });
    seed(file, { ordinal: 1, mappingId: "acme", origin: "Acme" });
    seed(file, { ordinal: 2, mappingId: "acme", origin: "Acme" });

    assert.deepStrictEqual(
      store.sessionsFor(file).map((s) => `${s.revision.id}/${s.mapping.id}`),
      ["rev-1/acme", "rev-2/acme", "rev-2/beta"]
    );
    assert.deepStrictEqual(
      store.revisionsFor(file).map((r) => r.ordinal),
      [1, 2]
    );
    assert.strictEqual(store.latestRevision(file)?.ordinal, 2);
    assert.strictEqual(store.nextRevision(file).id, "rev-3");
  });

  it("starts at round 1 for a document with no history", () => {
    const file = adoc("manuscript/chapter-02.adoc");
    assert.strictEqual(store.latestRevision(file), undefined);
    assert.strictEqual(store.nextRevision(file).ordinal, 1);
  });

  it("shows one mapping at a time, and switches on request", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const first = seed(file, { ordinal: 1, mappingId: "acme" });
    const second = seed(file, { ordinal: 2, mappingId: "acme" });

    // With no explicit choice the newest round is what you see.
    assert.strictEqual(store.get(file)?.sidecarPath, second.sidecarPath);
    assert.ok(store.setActive(first.sidecarPath));
    assert.strictEqual(store.get(file)?.sidecarPath, first.sidecarPath);
    assert.strictEqual(store.setActive(path.join(root, "nope.review.json")), false);
  });

  it("mints a mapping id that is free within its round", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const rev = { id: "rev-1", ordinal: 1 };
    seed(file, { ordinal: 1, mappingId: "copyedit" });
    assert.strictEqual(
      store.mintMappingId(file, rev, "/downloads/copyedit.pdf"),
      "copyedit-2"
    );
    // The same name in a *different* round is not a collision.
    assert.strictEqual(
      store.mintMappingId(file, { id: "rev-2", ordinal: 2 }, "/d/copyedit.pdf"),
      "copyedit"
    );
  });

  it("renames a round across every mapping in it", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const a = seed(file, { ordinal: 2, mappingId: "acme" });
    const b = seed(file, { ordinal: 2, mappingId: "beta" });
    const other = seed(file, { ordinal: 1, mappingId: "acme" });

    store.describeMapping(a.sidecarPath, {
      revision: { label: "Copyedit" },
      origin: "Acme Editorial",
    });

    assert.strictEqual(store.getBySidecar(a.sidecarPath)?.revision.label, "Copyedit");
    assert.strictEqual(store.getBySidecar(b.sidecarPath)?.revision.label, "Copyedit");
    // …and only that round.
    assert.strictEqual(store.getBySidecar(other.sidecarPath)?.revision.label, undefined);
    // The origin belongs to the one mapping, not the round.
    assert.strictEqual(
      store.getBySidecar(a.sidecarPath)?.mapping.origin,
      "Acme Editorial"
    );
    assert.strictEqual(store.getBySidecar(b.sidecarPath)?.mapping.origin, undefined);
    // Emptying a field clears it rather than being ignored as "no change".
    store.describeMapping(a.sidecarPath, { origin: undefined });
    assert.strictEqual(store.getBySidecar(a.sidecarPath)?.mapping.origin, undefined);
    // …but the id names the file, so it is never touched.
    assert.strictEqual(store.getBySidecar(a.sidecarPath)?.mapping.id, "acme");
    // It survives a reload from disk.
    const reread = new ReviewStore();
    reread.configure({ workspaceRoot: root, reviewFolder: ".eddie" });
    reread.tryLoadSidecar(file);
    assert.strictEqual(
      reread.getBySidecar(b.sidecarPath)?.revision.label,
      "Copyedit"
    );
    reread.dispose();
  });

  it("records produced artifacts against the mapping that made them", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const s = seed(file, { ordinal: 1, mappingId: "acme" });
    const report = path.join(path.dirname(s.sidecarPath), "acme.review.md");
    store.recordArtifact(s.sidecarPath, { kind: "report", path: report });
    store.recordArtifact(s.sidecarPath, { kind: "report", path: report });
    // Re-exporting updates the entry rather than growing the list.
    assert.strictEqual(store.getBySidecar(s.sidecarPath)?.artifacts?.length, 1);
    assert.strictEqual(
      store.getBySidecar(s.sidecarPath)?.artifacts?.[0].path,
      report
    );
  });

  it("discovers every round of a document from the review folder alone", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    seed(file, { ordinal: 1, mappingId: "acme" });
    seed(file, { ordinal: 2, mappingId: "acme" });
    seed(file, { ordinal: 2, mappingId: "beta" });

    const fresh = new ReviewStore();
    fresh.configure({ workspaceRoot: root, reviewFolder: ".eddie" });
    const active = fresh.tryLoadSidecar(file);
    assert.ok(active);
    assert.strictEqual(fresh.sessionsFor(file).length, 3);
    assert.strictEqual(fresh.revisionsFor(file).length, 2);
    fresh.dispose();
  });

  it("deletes one mapping without touching the manuscript or its siblings", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const a = seed(file, { ordinal: 2, mappingId: "acme" });
    const b = seed(file, { ordinal: 2, mappingId: "beta" });

    assert.ok(store.deleteMapping(b.sidecarPath));
    assert.strictEqual(fs.existsSync(b.sidecarPath), false);
    assert.strictEqual(fs.existsSync(a.sidecarPath), true);
    assert.strictEqual(fs.existsSync(file), true);
    assert.strictEqual(store.sessionsFor(file).length, 1);
    assert.strictEqual(store.get(file)?.sidecarPath, a.sidecarPath);
  });

  it("moves a legacy sidecar into the review folder, rewriting its paths", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    const legacy = path.join(root, "manuscript", "chapter-01.review.json");
    seed(file, { ordinal: 1, mappingId: "chapter-01", sidecarPath: legacy });

    const steps = store.planMigration();
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].from, legacy);
    assert.strictEqual(
      steps[0].to,
      path.join(
        root,
        ".eddie",
        "manuscript",
        "chapter-01",
        "rev-1",
        "chapter-01.review.json"
      )
    );

    const res = store.migrate(steps);
    assert.deepStrictEqual([res.moved, res.failed], [1, []]);
    assert.strictEqual(fs.existsSync(legacy), false);
    assert.strictEqual(fs.existsSync(steps[0].to), true);
    // The manuscript is untouched, and the moved file still points at it.
    assert.deepStrictEqual(fs.readdirSync(path.join(root, "manuscript")), [
      "chapter-01.adoc",
    ]);
    const moved = store.getBySidecar(steps[0].to);
    assert.strictEqual(moved?.adocPath, file);
    const text = fs.readFileSync(steps[0].to, "utf8");
    assert.ok(
      text.includes("../../../manuscript/chapter-01.adoc"),
      `expected a relative source path, got: ${text.slice(0, 400)}`
    );
    // Nothing left to do on a second run.
    assert.strictEqual(store.planMigration().length, 0);
  });

  it("has nothing to migrate when reviews already live in the folder", () => {
    const file = adoc("manuscript/chapter-01.adoc");
    seed(file, { ordinal: 1, mappingId: "acme" });
    assert.strictEqual(store.planMigration().length, 0);
  });
});
