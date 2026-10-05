import * as assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { shiftLine } from "../../core/matching/posTrack.js";
import type { ReviewItem } from "../../core/model/types.js";
import { decideClaim, openModeFor } from "../../hosts/obsidian/pure/claimDecision.js";
import { toContentChanges } from "../../hosts/obsidian/pure/changes.js";
import { buildMarkup, idsAtLine } from "../../hosts/obsidian/pure/markupModel.js";
import { normalizeRect, pdfFragment } from "../../hosts/obsidian/pure/pdfRect.js";
import {
  OBSIDIAN_DEFAULTS,
  sanitizeReviewFolder,
  sanitizeSettings,
} from "../../hosts/obsidian/pure/settingsMap.js";

function item(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "comment",
    page: 1,
    comment: id,
    anchoredText: "",
    rect: [0, 0, 1, 1],
    match: { startLine: 0, endLine: 0, score: 0.9, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

// @lat: [[tests#Obsidian host#Claiming adoc]]
describe("obsidian host: claiming .adoc", () => {
  // @truth-table
  it("claims only an unheld extension, and never against the setting", () => {
    assert.strictEqual(decideClaim(undefined, "auto"), "claim");
    assert.strictEqual(decideClaim("asciidoc-live-view", "auto"), "skip-held");
    assert.strictEqual(decideClaim("markdown", "auto"), "skip-held");
    assert.strictEqual(decideClaim("unknown", "auto"), "skip-unknown");
    assert.strictEqual(decideClaim(undefined, "never"), "skip-setting");
    assert.strictEqual(decideClaim("x", "never"), "skip-setting");
    assert.strictEqual(decideClaim("unknown", "never"), "skip-setting");
  });
});

describe("obsidian host: opening sources", () => {
  it("leaves Markdown and Eddie's own claims to Obsidian, and opens everything else in the built-in editor", () => {
    assert.strictEqual(openModeFor("md", []), "default");
    assert.strictEqual(openModeFor("adoc", ["adoc", "asciidoc"]), "default", "claimed by Eddie");
    assert.strictEqual(openModeFor("ADOC", ["adoc"]), "default", "case-insensitive");
    assert.strictEqual(openModeFor("adoc", []), "markdown", "held by another plugin, or nobody");
    assert.strictEqual(openModeFor("asciidoc", ["adoc"]), "markdown", "claimed only some");
    assert.strictEqual(openModeFor("asc", ["adoc", "asciidoc"]), "markdown", "never claimed");
  });
});

// @lat: [[tests#Obsidian host#Settings sanitising]]
describe("obsidian host: settings", () => {
  it("starts from a visible folder with PDF import on", () => {
    assert.strictEqual(OBSIDIAN_DEFAULTS.reviewFolder, "Eddie Reviews");
    assert.strictEqual(OBSIDIAN_DEFAULTS.importPdfs, true);
    assert.deepStrictEqual(sanitizeSettings(undefined), OBSIDIAN_DEFAULTS);
  });

  it("repairs corrupt values instead of failing", () => {
    const s = sanitizeSettings({
      reviewFolder: 42,
      matchThreshold: "high",
      highConfidence: 7,
      semanticThreshold: -3,
      stampOutput: "elsewhere",
      showResolved: "yes",
      claimAdoc: "sometimes",
      ollamaUrl: "   ",
      authorName: "  Pat  ",
      importPdfs: false,
      surprise: true,
    });
    assert.strictEqual(s.reviewFolder, "Eddie Reviews");
    assert.strictEqual(s.matchThreshold, OBSIDIAN_DEFAULTS.matchThreshold);
    assert.strictEqual(s.highConfidence, 1, "clamped");
    assert.strictEqual(s.semanticThreshold, 0, "clamped");
    assert.strictEqual(s.stampOutput, "reviewFolder");
    assert.strictEqual(s.showResolved, true);
    assert.strictEqual(s.claimAdoc, "auto");
    assert.strictEqual(s.ollamaUrl, OBSIDIAN_DEFAULTS.ollamaUrl);
    assert.strictEqual(s.authorName, "Pat");
    assert.strictEqual(s.importPdfs, true, "pinned: a PDF outside the vault is unreadable on mobile");
    assert.ok(!("surprise" in s));
    assert.strictEqual(sanitizeSettings({ pdfPreview: "tab", pdfRectMode: 3 }).pdfPreview, "own", "an unknown value falls back to the default");
    assert.strictEqual(sanitizeSettings({ pdfPreview: "builtin" }).pdfPreview, "builtin");
    assert.strictEqual(sanitizeSettings({ pdfRectMode: "top-left" }).pdfRectMode, "top-left");
    assert.strictEqual(sanitizeSettings({ pdfRectMode: 3 }).pdfRectMode, "pdf-user");
  });

  it("keeps the review folder inside the vault", () => {
    assert.strictEqual(sanitizeReviewFolder("Notes/Reviews/"), "Notes/Reviews");
    assert.strictEqual(sanitizeReviewFolder("/etc"), "Eddie Reviews");
    assert.strictEqual(sanitizeReviewFolder("C:\\Users\\me"), "Eddie Reviews");
    assert.strictEqual(sanitizeReviewFolder("../outside"), "Eddie Reviews");
    assert.strictEqual(sanitizeReviewFolder("a/../../b"), "Eddie Reviews");
    assert.strictEqual(sanitizeReviewFolder(""), "Eddie Reviews");
  });
});

// @lat: [[tests#Obsidian host#PDF link]]
describe("obsidian host: PDF link", () => {
  it("links to the page, adding the rectangle in PDF user space", () => {
    assert.strictEqual(pdfFragment(3, undefined), "#page=3");
    assert.strictEqual(pdfFragment(3, [72, 700, 300, 712]), "#page=3&rect=72,700,300,712");
  });

  it("normalizes a reversed rectangle and clamps it to the page", () => {
    assert.deepStrictEqual(normalizeRect([300, 712, 72, 700]), [72, 700, 300, 712]);
    assert.deepStrictEqual(
      normalizeRect([-50, -50, 900, 900], { view: [0, 0, 612, 792] }),
      [0, 0, 612, 792]
    );
  });

  it("drops a zero-area rectangle rather than highlighting a hairline", () => {
    assert.strictEqual(normalizeRect([10, 10, 10, 50]), null);
    assert.strictEqual(pdfFragment(2, [10, 10, 10.2, 11]), "#page=2");
  });

  it("flips to a top-left origin on request", () => {
    const g = { view: [0, 0, 612, 792] as [number, number, number, number] };
    assert.strictEqual(
      pdfFragment(1, [72, 700, 300, 712], "top-left", g),
      "#page=1&rect=72,80,300,92"
    );
    // Without page geometry there is nothing to flip against: stay in user space.
    assert.strictEqual(pdfFragment(1, [72, 700, 300, 712], "top-left"), "#page=1&rect=72,700,300,712");
  });

  it("never links below page 1", () => {
    assert.strictEqual(pdfFragment(0, undefined), "#page=1");
    assert.strictEqual(pdfFragment(2.9, undefined), "#page=2");
  });
});

// @lat: [[tests#Obsidian host#Markup model]]
describe("obsidian host: markup model", () => {
  const opts = { highConfidence: 0.75, showResolved: true };

  it("marks every covered line, badging only where an annotation starts", () => {
    const m = buildMarkup(
      [item("a", { number: 4, match: { startLine: 1, endLine: 3, score: 1, sourceExcerpt: "" } })],
      10,
      opts
    );
    assert.deepStrictEqual([...m.lines.keys()], [2, 3, 4]);
    assert.deepStrictEqual(m.lines.get(2)!.numbers, [4]);
    assert.deepStrictEqual(m.lines.get(3)!.numbers, []);
    assert.deepStrictEqual(idsAtLine(m, 3), ["a"]);
    assert.deepStrictEqual(idsAtLine(m, 9), []);
  });

  it("lets open work outrank resolved on a shared line", () => {
    const m = buildMarkup(
      [item("done", { resolved: true }), item("todo", { match: { startLine: 0, endLine: 0, score: 0.5, sourceExcerpt: "" } })],
      3,
      opts
    );
    assert.strictEqual(m.lines.get(1)!.state, "review");
    assert.deepStrictEqual(m.lines.get(1)!.ids, ["done", "todo"]);
    const onlyDone = buildMarkup([item("done", { resolved: true })], 3, opts);
    assert.strictEqual(onlyDone.lines.get(1)!.state, "resolved");
  });

  it("honours showResolved and skips unplaced annotations", () => {
    const items = [item("done", { resolved: true }), item("lost", { match: undefined })];
    assert.strictEqual(buildMarkup(items, 5, { ...opts, showResolved: false }).count, 0);
    assert.strictEqual(buildMarkup(items, 5, opts).count, 1);
  });

  it("clamps to the document, so a stale mapping never decorates a missing line", () => {
    const stale = item("s", { match: { startLine: 8, endLine: 12, score: 1, sourceExcerpt: "" } });
    assert.strictEqual(buildMarkup([stale], 5, opts).count, 0, "starts past the end");
    const long = item("l", { match: { startLine: 3, endLine: 99, score: 1, sourceExcerpt: "" } });
    assert.deepStrictEqual([...buildMarkup([long], 5, opts).lines.keys()], [4, 5]);
  });
});

// @lat: [[tests#Obsidian host#Editor changes]]
describe("obsidian host: editor changes", () => {
  /** Where each line of `before` lands in `after`, as CodeMirror itself maps it. */
  function truth(state: EditorState, specs: { from: number; to: number; insert: string }[]) {
    const tr = state.update({ changes: specs });
    return state.doc.toString().split("\n").map((_, i) => {
      const pos = tr.changes.mapPos(state.doc.line(i + 1).from, 1);
      return tr.state.doc.lineAt(pos).number - 1;
    });
  }

  function viaCore(state: EditorState, specs: { from: number; to: number; insert: string }[]) {
    const tr = state.update({ changes: specs });
    const cc = toContentChanges(state.doc, tr.changes);
    return state.doc.toString().split("\n").map((_, i) => shiftLine(i, cc));
  }

  const doc = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7";

  it("tracks a line through an insert above it", () => {
    const s = EditorState.create({ doc });
    const specs = [{ from: s.doc.line(2).from, to: s.doc.line(2).from, insert: "new a\nnew b\n" }];
    assert.deepStrictEqual(viaCore(s, specs), truth(s, specs));
  });

  it("tracks a line through several edits in one transaction", () => {
    const s = EditorState.create({ doc });
    // Insert two lines near the top, delete lines 4–5, add a line near the end.
    const specs = [
      { from: s.doc.line(2).from, to: s.doc.line(2).from, insert: "x\ny\n" },
      { from: s.doc.line(5).from, to: s.doc.line(6).from, insert: "" },
      { from: s.doc.line(8).from, to: s.doc.line(8).from, insert: "z\n" },
    ];
    // Lines not inside an edited region must agree exactly with CodeMirror.
    const got = viaCore(s, specs);
    const want = truth(s, specs);
    for (const i of [0, 1, 2, 5, 6, 7]) assert.strictEqual(got[i], want[i], `line ${i}`);
  });

  it("is a no-op for an edit within one line", () => {
    const s = EditorState.create({ doc });
    const specs = [{ from: 1, to: 2, insert: "xyz" }];
    assert.deepStrictEqual(viaCore(s, specs), doc.split("\n").map((_, i) => i));
  });

  it("reports changes in descending order, as shiftLine expects", () => {
    const s = EditorState.create({ doc });
    const tr = s.update({
      changes: [
        { from: s.doc.line(2).from, insert: "a\n" },
        { from: s.doc.line(6).from, insert: "b\n" },
      ],
    });
    const cc = toContentChanges(s.doc, tr.changes);
    // Whole lines at column 0 are reported at the end of the line above.
    assert.deepStrictEqual(cc.map((c) => c.startLine), [4, 0]);
    assert.deepStrictEqual(cc.map((c) => c.newLineCount), [1, 1]);
  });

  it("reports a mid-line insert on its own line, unshifted", () => {
    const s = EditorState.create({ doc });
    const tr = s.update({ changes: { from: s.doc.line(3).from + 1, insert: "x\ny" } });
    assert.deepStrictEqual(toContentChanges(s.doc, tr.changes), [
      { startLine: 2, endLine: 2, newLineCount: 1 },
    ]);
  });
});
