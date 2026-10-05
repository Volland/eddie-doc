import {
  Compartment,
  StateEffect,
  type Extension,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { createObsidianHost } from "./host.js";
import { useObsidianPdfEngine, type WorkerMode } from "./pdf/engine.js";
import { eddieEditorExtensions, markupField, setMarkup, type EditorBridge } from "./editor/extension.js";
import { registerCommands } from "./commands.js";
import { CLAIMABLE_EXTENSIONS, decideClaim, openModeFor, type Holder } from "./pure/claimDecision.js";
import { buildMarkup } from "./pure/markupModel.js";
import { OBSIDIAN_DEFAULTS, sanitizeSettings, type ObsidianSettings } from "./pure/settingsMap.js";
import { EddieSettingTab } from "./ui/settingsTab.js";
import { REVIEW_VIEW_TYPE, ReviewView } from "./ui/ReviewView.js";
import { PDF_PREVIEW_VIEW_TYPE, PdfPreviewView } from "./ui/PdfPreviewView.js";
import * as flows from "./flows.js";
import { loadReviewFolder } from "./flows.js";
import { ReviewStore } from "../../core/model/store.js";
import { effectiveLine } from "../../core/matching/mapper.js";
import type { ContentChange } from "../../core/matching/posTrack.js";
import type { HostServices } from "../../core/host/services.js";
import { isAdocPath } from "../../core/util/adoc.js";
import { itemSpan, itemTitle } from "../../core/view/annotationView.js";
import { availableActions } from "../../core/edits/plan.js";
import * as corePath from "../../core/util/path.js";
import { threadLabel } from "../../core/thread/threadModel.js";

/** Panel filters, kept between sessions. UI state only: never written to a sidecar. */
export interface PanelState {
  hidden: string[];
  text: string;
  kind: string;
  page: string;
}

const DEFAULT_PANEL: PanelState = { hidden: [], text: "", kind: "", page: "" };

/** Everything the plugin keeps in `data.json`. */
interface PluginData {
  settings?: unknown;
  panel?: Partial<PanelState>;
}

/** The annotation the panel and editor are focused on. */
export interface Selection {
  adocPath: string;
  id: string;
}

const LIVE_QUIET_MS = 200;
const REMAP_QUIET_MS = 1500;

export default class EddiePlugin extends Plugin implements EditorBridge {
  settings: ObsidianSettings = OBSIDIAN_DEFAULTS;
  store!: ReviewStore;
  host!: HostServices;
  workerMode: WorkerMode | undefined;
  selection: Selection | null = null;
  panel: PanelState = { ...DEFAULT_PANEL };
  /** The running long operation, if any; aborting it cancels extraction at the next page. */
  currentOp: AbortController | undefined;
  /** The tab the PDF preview is shown in, reused so selection does not open a tab per click. */
  previewLeaf: WorkspaceLeaf | undefined;
  /** The last `.adoc` that had focus, kept when focus moves to the panel. */
  lastAdoc: string | undefined;
  /** Extensions Eddie registered itself, and those another plugin holds. */
  claimed: string[] = [];
  heldByOthers: string[] = [];

  private editorExtensions: Extension[] = [];
  private readonly attached = new WeakSet<EditorView>();
  private readonly foreignSlot = new Compartment();
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly remapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statusEl: HTMLElement | undefined;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = sanitizeSettings(data.settings);
    this.panel = { ...DEFAULT_PANEL, ...(data.panel ?? {}) };

    this.workerMode = useObsidianPdfEngine();
    this.host = createObsidianHost(
      this.app,
      () => this.settings,
      () => this.settings.authorName.trim() || "Author"
    );
    this.store = new ReviewStore(this.host);
    this.store.configure({ workspaceRoot: "", reviewFolder: this.settings.reviewFolder });
    this.store.useEmbedCacheFile(`${this.manifest.dir ?? ".obsidian/plugins/eddie-doc"}/embed-cache.json`);

    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf, this));
    this.registerView(PDF_PREVIEW_VIEW_TYPE, (leaf) => new PdfPreviewView(leaf, this));
    this.addSettingTab(new EddieSettingTab(this.app, this));
    this.addRibbonIcon("message-square", "Eddie Doc: open the review panel", () => void this.showPanel());
    registerCommands(this);

    this.editorExtensions = eddieEditorExtensions(this);
    this.registerEditorExtension(this.editorExtensions);

    if (!Platform.isMobile) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("eddie-status");
      this.statusEl.addEventListener("click", () => void this.showPanel());
    }

    const sub = this.store.onDidChange(() => this.scheduleRefresh());
    this.register(() => sub.dispose());

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => void this.onFileOpen(file))
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.attachForeignEditors()));
    const isSidecar = (p: string) => /\.review\.json$/i.test(p);
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile)) return;
        if (isSidecar(f.path)) this.scheduleSidecarSync(f.path);
        else if (isAdocPath(f.path) && this.store.sessionsFor(f.path).length) this.scheduleRemap(f.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile && isSidecar(f.path)) this.scheduleSidecarSync(f.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile && isSidecar(f.path)) this.scheduleSidecarSync(f.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => void this.onRename(f.path, oldPath))
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const file = (view as MarkdownView).file;
        if (!file || !isAdocPath(file.path)) return;
        const session = this.store.get(file.path);
        if (!session) return;
        const line = editor.getCursor().line;
        const hits = session.items.filter((i) => {
          const sp = itemSpan(i);
          return sp && line >= sp.start && line <= sp.end;
        });
        for (const it of hits.slice(0, 3)) {
          const ref = { adocPath: file.path, id: it.id };
          const label = itemTitle(it).slice(0, 40);
          menu.addItem((m) => m.setSection("eddie").setTitle(`Eddie: show “${label}” in panel`).setIcon("message-square").onClick(() => this.select(it.id)));
          menu.addItem((m) =>
            m.setSection("eddie").setTitle(it.resolved ? "Eddie: reopen" : "Eddie: resolve").setIcon("check").onClick(() => flows.toggleResolved(this, ref))
          );
          menu.addItem((m) => m.setSection("eddie").setTitle("Eddie: preview in PDF").setIcon("file-text").onClick(() => void flows.previewPdf(this, file.path, it.id)));
          for (const a of availableActions(it, true).filter((x) => !x.needsText).slice(0, 3)) {
            menu.addItem((m) => m.setSection("eddie").setTitle(`Eddie: ${a.label}`).onClick(() => void flows.applyAction(this, a.action, ref)));
          }
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        const ext = file.extension.toLowerCase();
        if (ext === "pdf") {
          menu.addItem((m) => m.setSection("eddie").setTitle("Eddie: map this PDF…").setIcon("message-square").onClick(() => void flows.openReview(this, "ask", file.path)));
        } else if (isAdocPath(file.path) && this.store.sessionsFor(file.path).length) {
          menu.addItem((m) =>
            m.setSection("eddie").setTitle("Eddie: open review").setIcon("message-square").onClick(async () => {
              this.lastAdoc = file.path;
              await this.openSource(file.path);
              await this.showPanel();
              this.refreshAll();
            })
          );
        }
      })
    );

    this.app.workspace.onLayoutReady(() => void this.afterLayout());
  }

  async onunload(): Promise<void> {
    for (const t of this.remapTimers.values()) clearTimeout(t);
    for (const t of this.sidecarTimers.values()) clearTimeout(t);
    this.currentOp?.abort();
    if (this.liveTimer) clearTimeout(this.liveTimer);
    await this.store?.flush();
    this.store?.dispose();
  }

  /** Runs once every plugin has loaded, so claiming `.adoc` cannot steal from a later one. */
  private async afterLayout(): Promise<void> {
    this.claimAdoc();
    await loadReviewFolder(this);
    const open = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (open && isAdocPath(open.path)) {
      this.lastAdoc = open.path;
      await this.store.tryLoadSidecar(open.path);
    }
    this.attachForeignEditors();
    this.refreshAll();
  }

  // -- settings ---------------------------------------------------------------

  async updateSettings(patch: Partial<ObsidianSettings>): Promise<void> {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    this.store.configure({ workspaceRoot: "", reviewFolder: this.settings.reviewFolder });
    await this.saveData({ settings: this.settings, panel: this.panel } satisfies PluginData);
    this.refreshAll();
  }

  // -- .adoc ownership (ADR 0002) -----------------------------------------------

  /**
   * Obsidian lets one view type own an extension, and its registry is not part of
   * the public API, so every access is guarded: anything unexpected counts as
   * "someone has it".
   */
  private holderOf(ext: string): Holder {
    try {
      const reg = (this.app as unknown as { viewRegistry?: Record<string, unknown> }).viewRegistry;
      if (!reg) return "unknown";
      const map = reg.typeByExtension as Record<string, string> | undefined;
      if (map && typeof map === "object") return map[ext];
      const get = reg.getTypeByExtension as ((e: string) => string | undefined) | undefined;
      if (typeof get === "function") return get.call(reg, ext);
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  private claimAdoc(): void {
    for (const ext of CLAIMABLE_EXTENSIONS) {
      const decision = decideClaim(this.holderOf(ext), this.settings.claimAdoc);
      if (decision === "claim") {
        try {
          this.registerExtensions([ext], "markdown");
          this.claimed.push(ext);
          continue;
        } catch {
          // Obsidian refuses an extension that is already registered.
        }
      }
      this.heldByOthers.push(ext);
    }
  }

  /** Keep claimed `.adoc` files in source mode: markdown rendering of AsciiDoc is noise. */
  private async ensureSource(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) return;
    if (!this.claimed.includes(view.file.extension.toLowerCase())) return;
    const state = leaf.getViewState();
    if (state.state?.mode === "source" && state.state?.source === true) return;
    await leaf.setViewState({
      ...state,
      state: { ...state.state, mode: "source", source: true },
    });
  }

  private onLeafChange(): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf) void this.ensureSource(leaf);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && isAdocPath(view.file.path)) {
      this.lastAdoc = view.file.path;
    }
    this.attachForeignEditors();
    this.scheduleRefresh();
  }

  private async onFileOpen(file: TFile | null): Promise<void> {
    if (!file || !isAdocPath(file.path)) return;
    this.lastAdoc = file.path;
    await this.store.tryLoadSidecar(file.path);
    this.scheduleRefresh();
  }

  // -- editors ------------------------------------------------------------------

  /**
   * Stage 2 of ADR 0002: for an `.adoc` editor that another plugin owns, append the
   * same CodeMirror extensions to it. Idempotent, and tolerant of views that expose
   * no editor — the review panel works regardless.
   */
  private attachForeignEditors(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as {
        file?: TFile;
        editor?: { cm?: EditorView };
        cm?: EditorView;
        editorView?: EditorView;
        getViewType(): string;
      };
      if (view instanceof MarkdownView) return; // Obsidian's own: the registered extension covers it
      const file = view.file;
      if (!file || !isAdocPath(file.path)) return;
      const cm = view.cm ?? view.editor?.cm ?? view.editorView;
      if (!cm || typeof cm.dispatch !== "function" || this.attached.has(cm)) return;
      try {
        cm.dispatch({
          effects: StateEffect.appendConfig.of(this.foreignSlot.of(this.editorExtensions)),
        });
        this.attached.add(cm);
      } catch (e) {
        console.warn("Eddie Doc: could not attach to the editor of", view.getViewType(), e);
      }
    });
  }

  /** Every CodeMirror editor currently showing a file we know about. */
  private editors(): { cm: EditorView; path: string }[] {
    const out: { cm: EditorView; path: string }[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view as unknown as {
        file?: TFile;
        editor?: { cm?: EditorView };
        cm?: EditorView;
        editorView?: EditorView;
      };
      const cm = v.cm ?? v.editor?.cm ?? v.editorView;
      if (v.file && cm && typeof cm.dispatch === "function") out.push({ cm, path: v.file.path });
    });
    return out;
  }

  /** Push the review's marks into every open editor, and refresh the panel and status. */
  refreshAll(): void {
    for (const { cm, path } of this.editors()) {
      const session = this.store.get(path);
      if (!session) {
        if (this.hasMarkup(cm)) cm.dispatch({ effects: setMarkup.of({ markup: { lines: new Map(), count: 0 }, inline: false }) });
        continue;
      }
      const markup = buildMarkup(session.items, cm.state.doc.lines, {
        highConfidence: this.settings.highConfidence,
        showResolved: this.settings.showResolved,
      });
      cm.dispatch({ effects: setMarkup.of({ markup, inline: this.settings.inlineMarkers }) });
    }
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      (leaf.view as ReviewView).refresh();
    }
    this.updateStatus();
  }

  private hasMarkup(cm: EditorView): boolean {
    try {
      return !!cm.state.field(markupField, false)?.size;
    } catch {
      return false;
    }
  }

  scheduleRefresh(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.refreshAll();
    }, LIVE_QUIET_MS);
  }

  /** Re-map once the author stops typing, and only if the text actually moved. */
  private scheduleRemap(path: string): void {
    const pending = this.remapTimers.get(path);
    if (pending) clearTimeout(pending);
    this.remapTimers.set(
      path,
      setTimeout(() => {
        this.remapTimers.delete(path);
        void this.store.remapAll(path, this.settings.matchThreshold, { onlyIfSourceChanged: true });
      }, REMAP_QUIET_MS)
    );
  }

  private readonly sidecarTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** A sidecar changed, appeared or vanished: re-read it once the writes settle. */
  private scheduleSidecarSync(path: string): void {
    const t = this.sidecarTimers.get(path);
    if (t) clearTimeout(t);
    this.sidecarTimers.set(
      path,
      setTimeout(() => {
        this.sidecarTimers.delete(path);
        void this.store.reloadFromDisk(path).catch((e) => console.warn("Eddie Doc: could not re-read", path, e));
      }, 400)
    );
  }

  /** Something was renamed or moved in the vault: keep reviews attached to it. */
  private async onRename(newPath: string, oldPath: string): Promise<void> {
    // The review folder itself: follow it, or new mappings keep going to the old name.
    if (corePath.normalize(oldPath) === corePath.normalize(this.settings.reviewFolder)) {
      await this.updateSettings({ reviewFolder: newPath });
    }
    if (this.store.rebindPaths(oldPath, newPath)) {
      if (this.lastAdoc && corePath.normalize(this.lastAdoc) === corePath.normalize(oldPath)) this.lastAdoc = newPath;
      this.refreshAll();
    }
  }

  async savePanelState(): Promise<void> {
    await this.saveData({ settings: this.settings, panel: this.panel } satisfies PluginData);
  }

  /** Show a PDF page in Eddie's own viewer, reusing its tab. */
  async showPdfPreview(pdfPath: string, page: number, rect?: number[]): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PDF_PREVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("split");
      await leaf.setViewState({ type: PDF_PREVIEW_VIEW_TYPE, active: false });
    }
    await (leaf.view as PdfPreviewView).show(pdfPath, page, rect);
  }

  /** Begin a cancellable operation; any previous one is left to finish. */
  beginOp(): AbortController {
    const ctl = new AbortController();
    this.currentOp = ctl;
    return ctl;
  }

  endOp(ctl: AbortController): void {
    if (this.currentOp === ctl) this.currentOp = undefined;
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const path = this.resolvedAdoc();
    const s = path ? this.store.get(path) : undefined;
    if (!s) {
      this.statusEl.setText("");
      return;
    }
    const open = s.items.filter((i) => !i.resolved).length;
    this.statusEl.setText(`Eddie · r${s.revision.ordinal} · ${open} open`);
  }

  // -- EditorBridge -------------------------------------------------------------

  pathOf(view: EditorView): string | undefined {
    return this.editors().find((e) => e.cm === view)?.path;
  }

  onEdit(path: string, changes: ContentChange[]): void {
    if (!isAdocPath(path)) return;
    if (this.store.shiftPositions(path, changes)) this.scheduleRefresh();
  }

  select(id: string): void {
    const owner = this.store.locate(id);
    if (!owner) return;
    this.setSelection({ adocPath: owner.adocPath, id });
    void this.showPanel();
  }

  describe(id: string): { title: string; body: string } | undefined {
    const owner = this.store.locate(id);
    const item = owner?.items.find((i) => i.id === id);
    if (!item) return undefined;
    return { title: itemTitle(item), body: threadLabel(item) };
  }

  inlineMarkers(): boolean {
    return this.settings.inlineMarkers;
  }

  // -- shared helpers for the panel and the flows -----------------------------------

  /** The `.adoc` the UI is about: the active one, else the last one seen. */
  resolvedAdoc(): string | undefined {
    const v = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (v?.file && isAdocPath(v.file.path)) return v.file.path;
    if (this.lastAdoc && this.store.sessionsFor(this.lastAdoc).length) return this.lastAdoc;
    const all = this.store.all();
    return all.length ? all[all.length - 1].adocPath : undefined;
  }

  setSelection(sel: Selection | null): void {
    this.selection = sel;
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      (leaf.view as ReviewView).refresh();
    }
  }

  async showPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** The editor showing `path`, if it is open. */
  editorFor(path: string): MarkdownView | undefined {
    let found: MarkdownView | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) found = leaf.view;
    });
    return found;
  }

  /** Open `path` in an editor (reusing a tab that already shows it) and return its view. */
  async openSource(path: string, focus = true): Promise<MarkdownView | undefined> {
    // Since Obsidian 1.7.2 a background tab is deferred: its view is a placeholder
    // until loaded, so it would not be found as an editor and a second tab would open.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const deferred = (leaf as unknown as { isDeferred?: boolean; loadIfDeferred?(): Promise<void> });
      if (deferred.isDeferred && leaf.getViewState().state?.file === path) await deferred.loadIfDeferred?.();
    }
    const existing = this.editorFor(path);
    if (existing) {
      if (focus) await this.app.workspace.revealLeaf(existing.leaf);
      return existing;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Eddie Doc: ${path} is not in the vault.`);
      return undefined;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    if (openModeFor(file.extension, this.claimed) === "markdown") {
      // Another plugin owns this extension (or nobody does): open Eddie's own
      // source view of the file rather than whatever view that plugin provides.
      try {
        await leaf.setViewState({
          type: "markdown",
          state: { file: file.path, mode: "source", source: true },
          active: focus,
        });
      } catch (e) {
        console.warn("Eddie Doc: could not open", file.path, "in the source editor", e);
      }
    } else {
      await leaf.openFile(file, { active: focus });
    }
    if (leaf.view instanceof MarkdownView) return leaf.view;
    new Notice(
      `Eddie Doc: ${file.name} opened in a view Eddie cannot mark up. The review panel still works; ` +
        `open the file in Obsidian's built-in editor to see highlights.`,
      10000
    );
    return undefined;
  }

  /** The source as the author sees it: the live editor buffer, else the file. */
  async readSource(path: string): Promise<string> {
    const live = this.editorFor(path);
    return live ? live.editor.getValue() : this.host.storage.readText(path);
  }

  /** Save any open editor of `path`, so a store operation reads what is on screen. */
  async saveSource(path: string): Promise<void> {
    await this.editorFor(path)?.save();
  }

  /** Move the cursor to a 0-based line and scroll it into view. */
  async revealLine(path: string, line0: number): Promise<void> {
    const view = await this.openSource(path);
    if (!view) return;
    const l = Math.max(0, Math.min(line0, view.editor.lineCount() - 1));
    view.editor.setCursor({ line: l, ch: 0 });
    view.editor.scrollIntoView({ from: { line: l, ch: 0 }, to: { line: l, ch: 0 } }, true);
  }

  async revealItem(adocPath: string, id: string): Promise<void> {
    const item = this.store.findItem(adocPath, id);
    if (!item) return;
    const line = effectiveLine(item);
    if (line === Number.MAX_SAFE_INTEGER) {
      new Notice("Eddie Doc: this annotation has no source match yet — use Re-link or Triage.");
      return;
    }
    await this.revealLine(adocPath, line);
  }

  /** Name for replies: the setting, else ask once and remember. */
  async ensureAuthor(prompt: (title: string, opts: { detail: string }) => Promise<string | undefined>): Promise<string | undefined> {
    const have = this.settings.authorName.trim();
    if (have) return have;
    const name = (await prompt("Your name on replies", {
      detail: "Shown beside your replies in the review. You can change it in settings.",
    }))?.trim();
    if (!name) return undefined;
    await this.updateSettings({ authorName: name });
    return name;
  }
}
