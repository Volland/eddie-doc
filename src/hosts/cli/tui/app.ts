/**
 * `eddie tui`: browse documents → mappings → annotations in a full-screen
 * terminal UI, and act on them with single keys.
 *
 * This file is the whole UI minus the terminal: state, key handling and frame
 * rendering are plain functions of the store, so tests drive it with synthetic
 * keys and read the frame as text. `term.ts` connects it to a real TTY.
 *
 * Every action calls the same store method the editor and the one-shot
 * commands call, then flushes, so the sidecar on disk is always current and an
 * open VS Code window picks the change up.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { effectiveLine, isConfident } from "../../../core/matching/mapper.js";
import { buildSourceIndex, topMatches } from "../../../core/matching/fuzzyMatch.js";
import {
  applyEdits,
  availableActions,
  overlaps,
  parseSuggestion,
  planAllConfident,
  planDeleteLines,
  planDeleteStruck,
  planInsertAtMark,
  planInsertNote,
  planReplaceMarked,
  type ActionInfo,
  type TextEdit,
} from "../../../core/edits/plan.js";
import {
  applyFilter,
  bucketOf,
  BUCKET_LABEL,
  BUCKET_ORDER,
  countBuckets,
  isLocated,
  type Bucket,
  type Counts,
} from "../../../core/view/annotationView.js";
import {
  itemPdfPath,
  KIND_LABEL,
  mappingLabel,
  revisionLabel,
  type ReviewItem,
  type ReviewSession,
} from "../../../core/model/types.js";
import { itemLabel, line1 } from "../present.js";
import { openFile, writeReport } from "../actions.js";
import type { Workspace } from "../workspace.js";

/** A key as Node's readline `keypress` event reports it. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

type Style = (s: string) => string;
type Seg = [text: string, style?: Style];
type Line = Seg[];

interface ListState {
  cursor: number;
  scroll: number;
}
interface DocsView extends ListState {
  kind: "docs";
}
interface MappingsView extends ListState {
  kind: "mappings";
  adoc: string;
}
interface ItemsView extends ListState {
  kind: "items";
  adoc: string;
  sidecar: string;
  bucket?: Bucket;
  text?: string;
  hideResolved: boolean;
}
export interface MenuOption {
  label: string;
  hint?: string;
  run?: () => Promise<void> | void;
}
interface MenuView extends ListState {
  kind: "menu";
  title: string;
  options: MenuOption[];
  /** Shown under the options: a diff, an edit plan, help text. */
  detail?: Line[];
}
type View = DocsView | MappingsView | ItemsView | MenuView;

interface InputMode {
  prompt: string;
  value: string;
  submit: (value: string) => Promise<void> | void;
}

const BUCKET_TAG: Record<Bucket, string> = {
  open: "OPEN",
  review: "REVIEW",
  unmatched: "UNMATCHED",
  resolved: "DONE",
};

const HELP: Array<[string, string]> = [
  ["↑ ↓  j k", "move"],
  ["PgUp PgDn  g G", "page / first / last"],
  ["Enter  →", "open"],
  ["Esc  ←  Backspace", "back"],
  ["q  Ctrl-C", "quit"],
  ["", ""],
  ["Annotations", ""],
  ["Enter", "replies (link it, if unmatched)"],
  ["r", "resolve / reopen"],
  ["c", "confirm the match"],
  ["a", "add a reply"],
  ["e", "edit or delete a reply"],
  ["l", "link to a line number"],
  ["t", "suggest lines and link one (triage)"],
  ["m", "re-match automatically"],
  ["f", "fix: apply this mark's edit to the source"],
  ["A", "apply every confident edit"],
  ["o", "open the PDF"],
  ["b", "filter by group (cycles)"],
  ["/", "search text (empty clears)"],
  ["h", "hide / show resolved"],
  ["", ""],
  ["Mappings", ""],
  ["R", "re-map every round of the document"],
  ["p", "export the mapping's report"],
];

export interface TuiOptions {
  /** ANSI colours; off for NO_COLOR and in tests. */
  color?: boolean;
  /** How to open a file; injected so tests do not launch a viewer. */
  open?: (file: string) => void;
}

export class TuiApp {
  private stack: View[] = [];
  private input?: InputMode;
  private message = "";
  private messageIsError = false;
  done = false;
  /** Called when something should be redrawn outside a key press. */
  onRedraw?: () => void;
  private readonly sources = new Map<string, string[]>();
  private readonly st: Record<"bold" | "dim" | "inverse" | "red" | "green" | "yellow" | "cyan" | "magenta", Style>;

  constructor(
    private readonly ws: Workspace,
    private readonly opts: TuiOptions = {}
  ) {
    const on = opts.color ?? false;
    const w = (code: string): Style => (s) => (on && s ? `\x1b[${code}m${s}\x1b[0m` : s);
    this.st = {
      bold: w("1"),
      dim: w("2"),
      inverse: w("7"),
      red: w("31"),
      green: w("32"),
      yellow: w("33"),
      cyan: w("36"),
      magenta: w("35"),
    };
  }

  /** Open on one document, or on every reviewed document in the workspace. */
  async start(adocArg?: string): Promise<void> {
    if (adocArg) return this.openDoc(await this.ws.requireDoc(adocArg), true);
    await this.ws.loadAll();
    this.stack.push({ kind: "docs", cursor: 0, scroll: 0 });
    // One document: nothing to choose at this level.
    if (this.docs().length === 1) this.openDoc(this.docs()[0].adoc, true);
  }

  /** Show a one-line notice in the footer until the next key. */
  flash(message: string, error = false): void {
    this.message = message.replace(/\s+/g, " ").trim();
    this.messageIsError = error;
    this.onRedraw?.();
  }

  // -- data -------------------------------------------------------------------

  private get hc(): number {
    return this.ws.settings.highConfidence;
  }

  private docs() {
    return this.ws.store
      .documents()
      .map((adoc) => {
        const sessions = this.ws.store.sessionsFor(adoc);
        const newest = sessions[sessions.length - 1];
        return {
          adoc,
          sessions,
          rounds: this.ws.store.revisionsFor(adoc).length,
          counts: newest ? countBuckets(newest.items, this.hc) : undefined,
          updatedAt: sessions.map((s) => s.updatedAt).sort().pop() ?? "",
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private session(v: ItemsView): ReviewSession | undefined {
    return this.ws.store.getBySidecar(v.sidecar);
  }

  /** The annotations an items view shows, in the tree's group order. */
  private items(v: ItemsView): ReviewItem[] {
    const s = this.session(v);
    if (!s) return [];
    const shown = applyFilter(
      s.items,
      { hideResolved: v.hideResolved, buckets: v.bucket ? [v.bucket] : [], text: v.text },
      this.hc
    );
    const rank = (it: ReviewItem) => BUCKET_ORDER.indexOf(bucketOf(it, this.hc));
    return shown
      .map((it, i) => ({ it, i }))
      .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i)
      .map((x) => x.it);
  }

  private current(v: ItemsView): ReviewItem | undefined {
    return this.items(v)[v.cursor];
  }

  private lines(adoc: string): string[] {
    let l = this.sources.get(adoc);
    if (!l) {
      try {
        l = readFileSync(adoc, "utf8").split(/\r?\n/);
      } catch {
        l = [];
      }
      this.sources.set(adoc, l);
    }
    return l;
  }

  private count(v: View): number {
    switch (v.kind) {
      case "docs":
        return this.docs().length;
      case "mappings":
        return this.ws.store.sessionsFor(v.adoc).length;
      case "items":
        return this.items(v).length;
      case "menu":
        return v.options.length;
    }
  }

  /** A path relative to the workspace root, when it is inside it. */
  private rel(p: string): string {
    const r = path.relative(this.ws.opts.root, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
  }

  private top(): View {
    return this.stack[this.stack.length - 1];
  }

  // -- navigation -------------------------------------------------------------

  /** Show a document's mappings; with `skipSingle`, go straight into its only one. */
  private openDoc(adoc: string, skipSingle = false): void {
    const sessions = this.ws.store.sessionsFor(adoc);
    this.stack.push({ kind: "mappings", adoc, cursor: Math.max(0, sessions.length - 1), scroll: 0 });
    if (skipSingle && sessions.length === 1) this.pushItems(adoc, sessions[0].sidecarPath);
  }

  private pushItems(adoc: string, sidecar: string): void {
    this.ws.store.setActive(sidecar);
    this.stack.push({
      kind: "items",
      adoc,
      sidecar,
      cursor: 0,
      scroll: 0,
      hideResolved: !this.ws.settings.showResolved,
    });
  }

  private menu(title: string, options: MenuOption[], detail?: Line[]): void {
    this.stack.push({ kind: "menu", title, options, detail, cursor: 0, scroll: 0 });
  }

  private back(): void {
    if (this.stack.length > 1) this.stack.pop();
    else this.done = true;
  }

  private ask(prompt: string, value: string, submit: InputMode["submit"]): void {
    this.input = { prompt, value, submit };
  }

  // -- keys -------------------------------------------------------------------

  async key(k: Key): Promise<void> {
    if (k.ctrl && k.name === "c") {
      this.done = true;
      return;
    }
    if (this.input) return this.inputKey(k);
    this.message = "";
    const v = this.top();
    const ch = k.sequence && k.sequence.length === 1 && !k.ctrl ? k.sequence : undefined;
    const n = this.count(v);
    const page = 10;
    const move = (to: number) => (v.cursor = Math.max(0, Math.min(n - 1, to)));

    if (k.name === "up" || ch === "k") return void move(v.cursor - 1);
    if (k.name === "down" || ch === "j") return void move(v.cursor + 1);
    if (k.name === "pageup") return void move(v.cursor - page);
    if (k.name === "pagedown") return void move(v.cursor + page);
    if (k.name === "home" || ch === "g") return void move(0);
    if (k.name === "end" || ch === "G") return void move(n - 1);
    if (k.name === "escape" || k.name === "left" || k.name === "backspace") return this.back();
    if (ch === "q") {
      this.done = true;
      return;
    }
    if (ch === "?") {
      return this.menu(
        "Keys",
        HELP.map(([key, what]) => ({ label: key ? `${key.padEnd(18)} ${what}` : what ? what : "" }))
      );
    }
    const enter = k.name === "return" || k.name === "enter" || k.name === "right";

    switch (v.kind) {
      case "docs": {
        const d = this.docs()[v.cursor];
        if (enter && d) this.openDoc(d.adoc);
        return;
      }
      case "mappings":
        return this.mappingsKey(v, ch, enter);
      case "items":
        return this.itemsKey(v, ch, enter);
      case "menu": {
        const opt = v.options[v.cursor];
        if (enter && opt?.run) {
          this.stack.pop();
          await opt.run();
        } else if (enter) this.stack.pop();
        return;
      }
    }
  }

  private async inputKey(k: Key): Promise<void> {
    const inp = this.input!;
    if (k.name === "escape") {
      this.input = undefined;
      return;
    }
    if (k.name === "return" || k.name === "enter") {
      this.input = undefined;
      await inp.submit(inp.value);
      return;
    }
    if (k.name === "backspace") {
      inp.value = inp.value.slice(0, -1);
      return;
    }
    if (k.ctrl && k.name === "u") {
      inp.value = "";
      return;
    }
    const s = k.sequence ?? "";
    if (!k.ctrl && !k.meta && s && !/[\x00-\x1f\x7f]/.test(s)) inp.value += s;
  }

  private async mappingsKey(v: MappingsView, ch: string | undefined, enter: boolean): Promise<void> {
    const s = this.ws.store.sessionsFor(v.adoc)[v.cursor];
    if (!s) return;
    if (enter) return this.pushItems(v.adoc, s.sidecarPath);
    if (ch === "R") {
      this.flash("re-mapping…");
      const n = await this.ws.store.remapAll(v.adoc, this.ws.settings.matchThreshold);
      await this.ws.store.flush();
      this.sources.delete(v.adoc);
      this.flash(`re-mapped ${n} mapping(s)`);
    }
    if (ch === "p") {
      const out = await writeReport(this.ws, s);
      this.flash(`report written: ${this.rel(out)}`);
    }
  }

  private async itemsKey(v: ItemsView, ch: string | undefined, enter: boolean): Promise<void> {
    const store = this.ws.store;
    store.setActive(v.sidecar);
    const it = this.current(v);
    const done = async (msg: string) => {
      await store.flush();
      // An action can move the item to another group; keep the cursor on it.
      const at = it ? this.items(v).findIndex((x) => x.id === it.id) : -1;
      if (at >= 0) v.cursor = at;
      v.cursor = Math.max(0, Math.min(v.cursor, this.items(v).length - 1));
      this.flash(msg);
    };

    // Filters work on an empty list too.
    if (ch === "b") {
      const order: Array<Bucket | undefined> = [undefined, ...BUCKET_ORDER];
      v.bucket = order[(order.indexOf(v.bucket) + 1) % order.length];
      v.cursor = 0;
      return this.flash(v.bucket ? `showing ${BUCKET_LABEL[v.bucket]}` : "showing all groups");
    }
    if (ch === "h") {
      v.hideResolved = !v.hideResolved;
      v.cursor = 0;
      return this.flash(v.hideResolved ? "resolved hidden" : "resolved shown");
    }
    if (ch === "/") {
      return this.ask("Search: ", v.text ?? "", (t) => {
        v.text = t.trim() || undefined;
        v.cursor = 0;
      });
    }
    if (ch === "A") return this.applyAll(v);
    if (!it) return;

    // Enter on an annotation: link it if it has no place yet, else open its replies.
    if (enter) return isLocated(it) ? this.replyMenu(v, it) : this.triageMenu(v, it);
    switch (ch) {
      case "r":
        store.toggleResolved(v.adoc, it.id);
        return done(`${itemLabel(it)} ${it.resolved ? "resolved" : "reopened"}`);
      case "c":
        store.confirmMatch(v.adoc, it.id);
        return done(`${itemLabel(it)} confirmed`);
      case "a":
        return this.replyPrompt(v, it);
      case "e":
        return this.replyMenu(v, it);
      case "l": {
        const count = this.lines(v.adoc).length;
        return this.ask(`Link ${itemLabel(it)} to line (1-${count}): `, String(line1(it) ?? ""), async (s) => {
          const n = Number(s);
          if (!Number.isInteger(n) || n < 1 || n > count) return this.flash(`not a line number: ${s}`, true);
          store.setActive(v.sidecar);
          store.relink(v.adoc, it.id, n - 1);
          await done(`${itemLabel(it)} → line ${n}`);
        });
      }
      case "m":
        await store.remapItem(v.adoc, it.id, this.ws.settings.matchThreshold);
        {
          const after = store.findItem(v.adoc, it.id);
          return done(
            after && line1(after) != null && !after.stale
              ? `${itemLabel(it)} → line ${line1(after)}`
              : `${itemLabel(it)}: no confident match — press t or l`
          );
        }
      case "t":
        return this.triageMenu(v, it);
      case "f":
        return this.fixMenu(v, it);
      case "o": {
        const s = this.session(v);
        if (!s) return;
        const pdf = itemPdfPath(s, it);
        (this.opts.open ?? openFile)(pdf);
        return this.flash(`opened ${path.basename(pdf)} — page ${it.page}`);
      }
    }
  }

  private replyPrompt(v: ItemsView, it: ReviewItem): void {
    this.ask(`Reply to ${itemLabel(it)}: `, "", async (body) => {
      if (!body.trim()) return;
      this.ws.store.setActive(v.sidecar);
      this.ws.store.addReply(v.adoc, it.id, this.ws.authorName(), body);
      await this.ws.store.flush();
      this.flash("reply added");
    });
  }

  private replyMenu(v: ItemsView, it: ReviewItem): void {
    const replies = it.replies ?? [];
    this.menu(
      `Replies on ${itemLabel(it)}`,
      [{ label: "Add a reply…", run: () => this.replyPrompt(v, it) } as MenuOption].concat(replies.flatMap((r) => [
        {
          label: `Edit   ${r.author}: ${r.body.replace(/\s+/g, " ")}`,
          run: () =>
            this.ask("Edit reply: ", r.body, async (body) => {
              if (!body.trim()) return;
              this.ws.store.setActive(v.sidecar);
              this.ws.store.editReply(v.adoc, it.id, r.id, body);
              await this.ws.store.flush();
              this.flash("reply edited");
            }),
        },
        {
          label: `Delete ${r.author}: ${r.body.replace(/\s+/g, " ")}`,
          run: () =>
            this.menu("Delete this reply?", [
              {
                label: "Yes, delete it",
                run: async () => {
                  this.ws.store.setActive(v.sidecar);
                  this.ws.store.deleteReply(v.adoc, it.id, r.id);
                  await this.ws.store.flush();
                  this.flash("reply deleted");
                },
              },
              { label: "Cancel" },
            ]),
        },
      ])),
      this.itemDetail(v, it, 200)
    );
  }

  private triageMenu(v: ItemsView, it: ReviewItem): void {
    const lines = this.lines(v.adoc);
    const idx = buildSourceIndex(lines.join("\n"));
    const cands = topMatches(it.anchoredText || it.comment || "", idx, 9);
    if (!cands.length) return this.flash("no candidate lines — press l to link by number");
    this.menu(
      `Link ${itemLabel(it)} to…`,
      cands.map((c) => ({
        label: `L${String(c.startLine + 1).padEnd(5)} ${c.score.toFixed(2)}  ${lines[c.startLine]?.trim() ?? ""}`,
        run: async () => {
          this.ws.store.setActive(v.sidecar);
          this.ws.store.relink(v.adoc, it.id, c.startLine);
          await this.ws.store.flush();
          this.flash(`${itemLabel(it)} → line ${c.startLine + 1}`);
        },
      })),
      this.itemDetail(v, it, 200).slice(0, 4)
    );
  }

  private fixMenu(v: ItemsView, it: ReviewItem): void {
    const actions = availableActions(it, isLocated(it));
    if (!actions.length) return this.flash(isLocated(it) ? "no edit for this mark" : "unmatched — link it first");
    this.menu(
      `Fix ${itemLabel(it)}`,
      actions.map((a) => ({
        label: a.label,
        run: () => {
          if (!a.needsText) return this.confirmFix(v, it, a, "");
          this.ask(`${a.label.replace(/…$/, "")}: `, parseSuggestion(it.comment || ""), (text) =>
            text.trim() ? this.confirmFix(v, it, a, text) : undefined
          );
        },
      }))
    );
  }

  private planFix(source: string, it: ReviewItem, a: ActionInfo, text: string): TextEdit | null {
    switch (a.action) {
      case "delete-struck":
        return planDeleteStruck(source, it);
      case "delete-lines":
        return planDeleteLines(source, it);
      case "insert-note":
        return planInsertNote(source, it);
      case "replace-marked":
        return planReplaceMarked(source, it, text);
      case "insert-at-mark":
        return planInsertAtMark(source, it, text);
    }
  }

  private confirmFix(v: ItemsView, it: ReviewItem, a: ActionInfo, text: string): void {
    const source = readFileSync(v.adoc, "utf8");
    const edit = this.planFix(source, it, a, text);
    if (!edit) return this.flash("could not locate the marked text precisely — edit it by hand", true);
    const before = source.slice(edit.from, edit.to);
    this.menu(
      `${a.label.replace(/…$/, "")} in ${path.basename(v.adoc)}?`,
      [
        {
          label: "Apply",
          run: async () => {
            writeFileSync(v.adoc, applyEdits(readFileSync(v.adoc, "utf8"), [edit]), "utf8");
            const store = this.ws.store;
            store.setActive(v.sidecar);
            if (a.action !== "insert-note" && !it.resolved) store.toggleResolved(v.adoc, it.id);
            await store.remapAll(v.adoc, this.ws.settings.matchThreshold, { onlyIfSourceChanged: true });
            await store.flush();
            this.sources.delete(v.adoc);
            this.flash(`${itemLabel(it)}: applied`);
          },
        },
        { label: "Cancel" },
      ],
      [
        [["- ", this.st.red], [JSON.stringify(before), this.st.red]],
        [["+ ", this.st.green], [JSON.stringify(edit.insert), this.st.green]],
      ]
    );
  }

  private applyAll(v: ItemsView): void {
    const s = this.session(v);
    if (!s) return;
    const source = readFileSync(v.adoc, "utf8");
    const planned = planAllConfident(source, s.items, (i) => isConfident(i, this.hc));
    if (!planned.length) return this.flash("no confident edits to apply");
    if (overlaps(planned.map((p) => p.edit))) return this.flash("edits overlap — apply them one at a time with f", true);
    this.menu(
      `Apply ${planned.length} edit(s) to ${path.basename(v.adoc)}?`,
      [
        {
          label: `Apply all ${planned.length}`,
          run: async () => {
            writeFileSync(v.adoc, applyEdits(readFileSync(v.adoc, "utf8"), planned.map((p) => p.edit)), "utf8");
            const store = this.ws.store;
            store.setActive(v.sidecar);
            for (const p of planned) store.toggleResolved(v.adoc, p.id);
            await store.remapAll(v.adoc, this.ws.settings.matchThreshold, { onlyIfSourceChanged: true });
            await store.flush();
            this.sources.delete(v.adoc);
            this.flash(`applied ${planned.length} edit(s)`);
          },
        },
        { label: "Cancel" },
      ],
      planned.map((p, i) => [[`${String(i + 1).padStart(3)}. ${p.label}`]])
    );
  }

  // -- rendering --------------------------------------------------------------

  /** The whole screen: exactly `rows` lines, each at most `cols` wide. */
  render(cols: number, rows: number): string[] {
    const v = this.top();
    const out: string[] = [];
    // Cut the breadcrumb from the left: where you are matters more than where you came from.
    const crumb = ` eddie · ${this.breadcrumb()}`;
    out.push(this.st.inverse(fit(crumb.length > cols ? "…" + crumb.slice(crumb.length - cols + 1) : crumb, cols)));

    const bodyH = Math.max(1, rows - 2);
    const detail = this.detail(v, cols);
    let listH = bodyH;
    if (detail.length) {
      const share = v.kind === "items" ? 0.5 : 0.35;
      const detH = Math.min(detail.length + 1, Math.max(3, Math.floor(bodyH * share)));
      listH = Math.max(1, bodyH - detH);
    }
    const n = this.count(v);
    v.cursor = Math.max(0, Math.min(v.cursor, n - 1));
    if (v.cursor < v.scroll) v.scroll = v.cursor;
    if (v.cursor >= v.scroll + listH) v.scroll = v.cursor - listH + 1;
    v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, n - listH)));

    const rowsOut = this.rows(v);
    for (let i = 0; i < listH; i++) {
      const idx = v.scroll + i;
      const line = rowsOut[idx];
      if (!line) {
        out.push(i === 0 && n === 0 ? this.st.dim(fit(`  ${this.emptyText(v)}`, cols)) : "");
        continue;
      }
      out.push(idx === v.cursor ? this.st.inverse(fit(`› ${plain(line)}`, cols)) : renderLine([["  "], ...line], cols));
    }
    if (detail.length) {
      out.push(this.st.dim("─".repeat(cols)));
      for (const l of detail.slice(0, bodyH - listH - 1)) out.push(renderLine(l, cols));
      while (out.length < rows - 1) out.push("");
    }
    out.push(this.footer(cols));
    return out.slice(0, rows);
  }

  private breadcrumb(): string {
    const parts: string[] = [];
    for (const v of this.stack) {
      if (v.kind === "docs") parts.push("workspace");
      if (v.kind === "mappings") parts.push(this.rel(v.adoc));
      if (v.kind === "items") {
        const s = this.session(v);
        if (s) parts.push(`${revisionLabel(s.revision)} · ${mappingLabel(s)}`);
        const f = [v.bucket ? BUCKET_LABEL[v.bucket] : "", v.text ? `"${v.text}"` : "", v.hideResolved ? "resolved hidden" : ""]
          .filter(Boolean)
          .join(", ");
        if (f) parts.push(`[${f}]`);
      }
      if (v.kind === "menu") parts.push(v.title);
    }
    return parts.join(" › ");
  }

  private emptyText(v: View): string {
    if (v.kind === "docs") return "No reviews in this workspace. Map one with: eddie open <source.adoc> <annotated.pdf>";
    if (v.kind === "items") return "No annotations match. Press b, h or / to change the filter.";
    return "Nothing here.";
  }

  private footer(cols: number): string {
    if (this.input) return fit(`${this.input.prompt}${this.input.value}█`, cols);
    if (this.message) return (this.messageIsError ? this.st.red : this.st.cyan)(fit(` ${this.message}`, cols));
    const v = this.top();
    const hints =
      v.kind === "items"
        ? "r resolve  c confirm  a reply  l link  t triage  f fix  o pdf  b group  / search  ? keys  ← back"
        : v.kind === "mappings"
          ? "Enter annotations  R re-map  p report  ? keys  ← back  q quit"
          : v.kind === "menu"
            ? "Enter choose  Esc cancel"
            : "Enter open  ? keys  q quit";
    return this.st.dim(fit(` ${hints}`, cols));
  }

  private countsSegs(c: Counts | undefined): Seg[] {
    if (!c) return [];
    return [
      [`${c.open} open`, this.st.green],
      [" · "],
      [`${c.review} review`, this.st.yellow],
      [" · "],
      [`${c.unmatched} unmatched`, this.st.red],
      [" · "],
      [`${c.resolved} done`, this.st.dim],
    ];
  }

  private rows(v: View): Line[] {
    switch (v.kind) {
      case "docs":
        return this.docs().map((d) => [
          [this.rel(d.adoc).padEnd(36), this.st.bold],
          [` ${d.rounds} round(s)  `, this.st.dim],
          ...this.countsSegs(d.counts),
        ]);
      case "mappings": {
        const sessions = this.ws.store.sessionsFor(v.adoc);
        return sessions.map((s, i) => [
          [i === sessions.length - 1 ? "* " : "  ", this.st.yellow],
          [`${s.revision.id}/${s.mapping.id}`.padEnd(30)],
          [` ${mappingLabel(s)}`.padEnd(22), this.st.bold],
          ...this.countsSegs(countBuckets(s.items, this.hc)),
        ]);
      }
      case "items":
        return this.items(v).map((it) => {
          const b = bucketOf(it, this.hc);
          const l = line1(it);
          return [
            [itemLabel(it).padEnd(8)],
            [BUCKET_TAG[b].padEnd(10), this.bucketStyle(b)],
            [KIND_LABEL[it.kind].padEnd(10), this.st.magenta],
            [(l == null ? "—" : `L${l}`).padEnd(7), this.st.dim],
            [oneLine(it.comment || it.markedText || it.anchoredText)],
            [it.replies?.length ? `  ↳${it.replies.length}` : "", this.st.cyan],
          ];
        });
      case "menu":
        return v.options.map((o) => [[o.label], [o.hint ? `  ${o.hint}` : "", this.st.dim]]);
    }
  }

  private bucketStyle(b: Bucket): Style {
    return b === "open" ? this.st.green : b === "review" ? this.st.yellow : b === "unmatched" ? this.st.red : this.st.dim;
  }

  private detail(v: View, cols: number): Line[] {
    if (v.kind === "menu") return v.detail ?? [];
    if (v.kind === "mappings") {
      const s = this.ws.store.sessionsFor(v.adoc)[v.cursor];
      if (!s) return [];
      const who = [s.mapping.origin, s.mapping.reviewer, s.mapping.reviewType].filter(Boolean).join(" · ");
      return [
        [[`${revisionLabel(s.revision)} · ${mappingLabel(s)}`, this.st.bold], [who ? `  ${who}` : "", this.st.dim]],
        [["sidecar  ", this.st.dim], [this.rel(s.sidecarPath)]],
        [["pdf      ", this.st.dim], [this.rel(s.pdfPath)], [s.extraPdfs?.length ? `  +${s.extraPdfs.length} more` : ""]],
        [["updated  ", this.st.dim], [s.updatedAt.slice(0, 16).replace("T", " ")]],
        ...(s.revision.note ? [[["note     ", this.st.dim] as Seg, [s.revision.note] as Seg]] : []),
      ];
    }
    if (v.kind === "items") {
      const it = this.current(v);
      return it ? this.itemDetail(v, it, cols) : [];
    }
    return [];
  }

  private itemDetail(v: ItemsView, it: ReviewItem, cols: number): Line[] {
    const b = bucketOf(it, this.hc);
    const l = line1(it);
    const how =
      l == null
        ? "unmatched"
        : it.manualLine != null
          ? `line ${l}, linked by hand`
          : `line ${l}, ${it.match?.method ?? "fuzzy"} ${it.match?.score.toFixed(2)}`;
    const out: Line[] = [
      [
        [`${itemLabel(it)}  `, this.st.bold],
        [`${KIND_LABEL[it.kind]}  `, this.st.magenta],
        [`${BUCKET_LABEL[b]}`, this.bucketStyle(b)],
        [`  page ${it.page} · ${how}${it.confirmed ? " · confirmed" : ""}${it.stale ? " · STALE" : ""}`, this.st.dim],
      ],
    ];
    const width = Math.max(20, cols - 4);
    const block = (label: string, text: string | undefined, style?: Style) => {
      if (!text?.trim()) return;
      wrap(oneLine(text), width - label.length).forEach((w, i) =>
        out.push([[i ? " ".repeat(label.length) : label, this.st.dim], [w, style]])
      );
    };
    block(`${it.author ?? "Editor"}: `, it.comment);
    block("marked: ", it.markedText || it.anchoredText, this.st.yellow);
    if (l != null) {
      const src = this.lines(v.adoc);
      const end = it.manualLine != null ? l : (it.match?.endLine ?? l - 1) + 1;
      for (let n = Math.max(1, l - 1); n <= Math.min(src.length, end + 1); n++) {
        const inside = n >= l && n <= end;
        out.push([[`${inside ? "▌" : " "}${String(n).padStart(5)} │ `, this.st.dim], [src[n - 1] ?? "", inside ? undefined : this.st.dim]]);
      }
    }
    for (const r of it.replies ?? []) {
      out.push([[`  ↳ ${r.author} · ${r.createdAt.slice(0, 10)}`, this.st.cyan]]);
      for (const w of wrap(oneLine(r.body), width - 4)) out.push([["    "], [w]]);
    }
    return out;
  }
}

// -- text helpers ---------------------------------------------------------------

function oneLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Pad or cut `s` to exactly `width` columns. */
export function fit(s: string, width: number): string {
  if (width <= 0) return "";
  const t = s.replace(/[\r\n\t]/g, " ");
  return t.length > width ? t.slice(0, width - 1) + "…" : t.padEnd(width);
}

function plain(line: Line): string {
  return line.map(([t]) => t).join("");
}

/** Styled segments cut to `width`, styles applied after cutting so codes are never split. */
function renderLine(line: Line, width: number): string {
  let left = width;
  let out = "";
  const total = plain(line).length;
  for (const [text, style] of line) {
    if (left <= 0) break;
    let t = text.replace(/[\r\n\t]/g, " ");
    if (t.length > left || (t.length === left && total > width)) t = t.slice(0, Math.max(0, left - 1)) + "…";
    left -= t.length;
    out += style ? style(t) : t;
  }
  return out;
}

export function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
    while (cur.length > w) {
      out.push(cur.slice(0, w));
      cur = cur.slice(w);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Strip ANSI codes, for tests and width checks. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
