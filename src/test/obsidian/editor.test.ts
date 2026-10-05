import * as assert from "node:assert";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { markupField, setMarkup } from "../../hosts/obsidian/editor/extension.js";
import { buildMarkup } from "../../hosts/obsidian/pure/markupModel.js";
import type { ReviewItem } from "../../core/model/types.js";

function item(id: string, start: number, end: number, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "comment",
    page: 1,
    comment: id,
    anchoredText: "",
    rect: [0, 0, 1, 1],
    number: Number(id.replace(/\D/g, "")) || undefined,
    match: { startLine: start, endLine: end, score: 0.9, sourceExcerpt: "" },
    resolved: false,
    ...over,
  };
}

const DOC = ["zero", "one", "two", "three", "four", "five"].join("\n");
const opts = { highConfidence: 0.75, showResolved: true };

/** Every decoration as `[line, class]` for line decorations, `[line, "widget"]` for widgets. */
function describeDecorations(state: EditorState): Array<[number, string]> {
  const set: DecorationSet = state.field(markupField);
  const out: Array<[number, string]> = [];
  set.between(0, state.doc.length, (from, _to, d) => {
    const cls = (d.spec as { attributes?: { class?: string } }).attributes?.class;
    out.push([state.doc.lineAt(from).number, cls ?? "widget"]);
  });
  return out;
}

function withMarkup(items: ReviewItem[], inline = false): EditorState {
  const base = EditorState.create({ doc: DOC, extensions: [markupField] });
  const markup = buildMarkup(items, base.doc.lines, opts);
  return base.update({ effects: setMarkup.of({ markup, inline }) }).state;
}

// @lat: [[tests#Obsidian host#Editor decorations]]
describe("obsidian host: editor decorations", () => {
  it("starts empty, then paints open, needs-review and resolved lines differently", () => {
    const empty = EditorState.create({ doc: DOC, extensions: [markupField] });
    assert.deepStrictEqual(describeDecorations(empty), []);

    const state = withMarkup([
      item("a1", 1, 1),
      item("a2", 2, 2, { match: { startLine: 2, endLine: 2, score: 0.5, sourceExcerpt: "" } }),
      item("a3", 4, 4, { resolved: true }),
    ]);
    assert.deepStrictEqual(describeDecorations(state), [
      [2, "eddie-line eddie-open"],
      [3, "eddie-line eddie-review"],
      [5, "eddie-line eddie-resolved"],
    ]);
  });

  it("carries the annotations on the decoration itself, so the gutter and hover read the same data", () => {
    const state = withMarkup([item("a1", 1, 2)]);
    const seen: Array<{ ids: string[]; startIds: string[]; numbers: number[] }> = [];
    state.field(markupField).between(0, state.doc.length, (_f, _t, d) => {
      const m = (d.spec as { mark?: (typeof seen)[number] }).mark;
      if (m) seen.push(m);
    });
    assert.deepStrictEqual(seen.map((m) => m.ids), [["a1"], ["a1"]]);
    assert.deepStrictEqual(seen.map((m) => m.startIds), [["a1"], []], "badge only where it starts");
    assert.deepStrictEqual(seen[0].numbers, [1]);
  });

  it("moves with the text when lines are inserted above, with no new push needed", () => {
    const state = withMarkup([item("a1", 3, 3)]);
    assert.deepStrictEqual(describeDecorations(state), [[4, "eddie-line eddie-open"]]);
    const after = state.update({ changes: { from: 0, insert: "new first line\nanother\n" } }).state;
    assert.deepStrictEqual(describeDecorations(after), [[6, "eddie-line eddie-open"]]);
    assert.strictEqual(after.doc.line(6).text, "three", "still on the same text");
  });

  it("drops a decoration whose line is deleted", () => {
    const state = withMarkup([item("a1", 3, 3), item("a2", 5, 5)]);
    const line = state.doc.line(4);
    const after = state.update({ changes: { from: line.from, to: line.to + 1, insert: "" } }).state;
    assert.deepStrictEqual(describeDecorations(after).map(([l]) => l), [5], "only the surviving mark remains");
  });

  it("adds an end-of-line marker per annotated line only when asked, and replaces rather than stacks", () => {
    const items = [item("a1", 1, 1), item("a2", 3, 3, { kind: "strikeout" })];
    const plain = describeDecorations(withMarkup(items, false));
    assert.strictEqual(plain.filter(([, c]) => c === "widget").length, 0);

    const inline = withMarkup(items, true);
    assert.strictEqual(describeDecorations(inline).filter(([, c]) => c === "widget").length, 2);

    // A second push replaces the first completely.
    const markup = buildMarkup([item("b1", 0, 0)], inline.doc.lines, opts);
    const again = inline.update({ effects: setMarkup.of({ markup, inline: false }) }).state;
    assert.deepStrictEqual(describeDecorations(again), [[1, "eddie-line eddie-open"]]);
  });

  it("never decorates a line that no longer exists", () => {
    const base = EditorState.create({ doc: "only\ntwo", extensions: [markupField] });
    const markup = buildMarkup([item("a1", 5, 6)], 99 /* a stale view of a longer file */, opts);
    const state = base.update({ effects: setMarkup.of({ markup, inline: true }) }).state;
    assert.deepStrictEqual(describeDecorations(state), []);
  });
});
