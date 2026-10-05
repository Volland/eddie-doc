import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  hoverTooltip,
  type DecorationSet,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { ContentChange } from "../../../core/matching/posTrack.js";
import { toContentChanges } from "../pure/changes.js";
import type { LineMark, Markup } from "../pure/markupModel.js";

/** What the editor extension needs from the plugin. */
export interface EditorBridge {
  /** The document path of an editor, or undefined when it is not a file view. */
  pathOf(view: EditorView): string | undefined;
  /** Text edits to feed back into the review's live line tracking. */
  onEdit(path: string, changes: ContentChange[]): void;
  /** The user clicked a gutter badge. */
  select(id: string): void;
  /** Hover content for an annotation, or undefined if it is gone. */
  describe(id: string): { title: string; body: string } | undefined;
  /** The `inlineMarkers` setting. */
  inlineMarkers(): boolean;
}

/** Push a freshly built {@link Markup} into one editor. */
export const setMarkup = StateEffect.define<{ markup: Markup; inline: boolean }>();

const KIND_GLYPH: Record<string, string> = {
  highlight: "▍",
  strikeout: "S̶",
  underline: "_",
  comment: "💬",
  insert: "⁁",
  freetext: "T",
};

class InlineMarker extends WidgetType {
  constructor(private readonly kinds: string[], private readonly state: string) {
    super();
  }
  eq(o: InlineMarker): boolean {
    return o.state === this.state && o.kinds.join() === this.kinds.join();
  }
  toDOM(): HTMLElement {
    const el = activeDocument.createElement("span");
    el.className = `eddie-inline eddie-${this.state}`;
    el.textContent = " " + this.kinds.map((k) => KIND_GLYPH[k] ?? "•").join("");
    el.setAttribute("aria-hidden", "true"); // decoration only; never document text
    return el;
  }
}

// @lat: [[obsidian#Editor markup]]
/**
 * The review's marks as decorations, kept in one field so CodeMirror maps them
 * through edits itself. The gutter and hover read their data out of the
 * decorations (their `spec`), which means they cannot disagree with the lines
 * that are highlighted, even for the frame between a keystroke and the next
 * push from the plugin.
 */
export const markupField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setMarkup)) continue;
      const { markup, inline } = e.value;
      const doc = tr.state.doc;
      const b = new RangeSetBuilder<Decoration>();
      const lines = [...markup.lines.values()].sort((x, y) => x.line - y.line);
      for (const m of lines) {
        if (m.line < 1 || m.line > doc.lines) continue;
        const line = doc.line(m.line);
        b.add(
          line.from,
          line.from,
          Decoration.line({ attributes: { class: `eddie-line eddie-${m.state}` }, mark: m })
        );
        if (inline && m.kinds.length) {
          b.add(
            line.to,
            line.to,
            Decoration.widget({ widget: new InlineMarker(m.kinds, m.state), side: 1, mark: m })
          );
        }
      }
      return b.finish();
    }
    if (!tr.docChanged) return value;
    // A zero-length decoration survives the deletion of its line by sliding onto
    // the next one, which would put a mark on text it was never about. Drop those
    // before mapping the rest; the plugin's next refresh restores anything real.
    const before = tr.startState.doc;
    const removed: Array<[number, number]> = [];
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      if (fromB === toB) removed.push([fromA, toA]); // a pure deletion
    });
    const kept = removed.length
      ? value.update({
          filter: (from) => {
            const line = before.lineAt(from);
            const end = Math.min(line.to + 1, before.length); // the line and its break
            return !removed.some(([a, b]) => a <= line.from && b >= end);
          },
        })
      : value;
    return kept.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The {@link LineMark} on the line starting at `from`, read from the decorations. */
function markAt(view: EditorView, from: number): LineMark | undefined {
  let found: LineMark | undefined;
  view.state.field(markupField, false)?.between(from, from, (_f, _t, d) => {
    const m = (d.spec as { mark?: LineMark }).mark;
    if (m && !found) found = m;
  });
  return found;
}

class Badge extends GutterMarker {
  constructor(private readonly mark: LineMark, private readonly onPick: (id: string) => void) {
    super();
  }
  eq(o: Badge): boolean {
    return (
      o.mark.state === this.mark.state &&
      o.mark.numbers.join() === this.mark.numbers.join() &&
      o.mark.startIds.join() === this.mark.startIds.join()
    );
  }
  toDOM(): HTMLElement {
    const el = activeDocument.createElement("span");
    el.className = `eddie-badge eddie-${this.mark.state}`;
    el.textContent = this.mark.numbers.length ? this.mark.numbers.join(",") : "•";
    el.dataset.ids = this.mark.startIds.join(" ");
    return el;
  }
}

function annotationGutter(bridge: EditorBridge): Extension {
  return gutter({
    class: "eddie-gutter",
    lineMarker(view, line) {
      const m = markAt(view, line.from);
      return m && m.startIds.length ? new Badge(m, bridge.select) : null;
    },
    lineMarkerChange: (u) =>
      u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setMarkup))),
    domEventHandlers: {
      click(view, line) {
        const id = markAt(view, line.from)?.startIds[0];
        if (id) bridge.select(id);
        return !!id;
      },
    },
  });
}

function annotationHover(bridge: EditorBridge): Extension {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const m = markAt(view, line.from);
    if (!m) return null;
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create() {
        const dom = activeDocument.createElement("div");
        dom.className = "eddie-hover";
        for (const id of m.ids) {
          const d = bridge.describe(id);
          if (!d) continue;
          const row = dom.createDiv({ cls: "eddie-hover-row" });
          row.createDiv({ cls: "eddie-hover-title", text: d.title });
          if (d.body) row.createDiv({ cls: "eddie-hover-body", text: d.body });
        }
        return { dom };
      },
    };
  });
}

/** Feeds edits back so annotations keep pointing at their text between saves. */
function changeBridge(bridge: EditorBridge): Extension {
  return ViewPlugin.fromClass(
    class {
      update(u: import("@codemirror/view").ViewUpdate) {
        if (!u.docChanged) return;
        const path = bridge.pathOf(u.view);
        if (!path) return;
        const changes = toContentChanges(u.startState.doc, u.changes);
        // Deferred: this runs inside an update, and the plugin may dispatch.
        queueMicrotask(() => bridge.onEdit(path, changes));
      }
    }
  );
}

/** Resets markdown styling on `.adoc` files, so `== Heading` is not shown as markdown. */
const adocScope = EditorView.contentAttributes.compute([], (state): Record<string, string> => {
  const ext = state.field(editorInfoField, false)?.file?.extension?.toLowerCase();
  return ext && /^(adoc|asciidoc|asc|ad)$/.test(ext) ? { class: "eddie-adoc" } : {};
});

export function eddieEditorExtensions(bridge: EditorBridge): Extension[] {
  return [markupField, annotationGutter(bridge), annotationHover(bridge), changeBridge(bridge), adocScope];
}
