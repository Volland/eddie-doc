import { ItemView, MarkdownRenderer, Menu, Platform, type WorkspaceLeaf } from "obsidian";
import type EddiePlugin from "../main.js";
import * as f from "../flows.js";
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  applyFilter,
  countBuckets,
  groupItems,
  isLocated,
  itemTitle,
} from "../../../core/view/annotationView.js";
import { availableActions } from "../../../core/edits/plan.js";
import { rootMarkdown, threadLabel } from "../../../core/thread/threadModel.js";
import { markAuthor } from "../../../core/thread/threadModel.js";
import { KIND_LABEL, mappingLabel, revisionLabel, type AnnotationKind, type ReviewItem } from "../../../core/model/types.js";
import * as path from "../../../core/util/path.js";

export const REVIEW_VIEW_TYPE = "eddie-review";

// @lat: [[obsidian#Review panel]]
/**
 * The review panel: the annotation list, the selected annotation's thread, and
 * every action on it.
 *
 * It stands in for four VS Code surfaces at once — the tree view, the Problems
 * panel, the Comments API threads and the lightbulb actions — because Obsidian
 * has none of them. One panel, rather than inline widgets, also keeps the same
 * layout working on a phone, where it simply fills the screen.
 */
export class ReviewView extends ItemView {
  /** Unsent reply text, per annotation, so a refresh never eats what is being typed. */
  private readonly drafts = new Map<string, string>();
  private editing: { id: string; replyId: string } | null = null;
  private autoSelected = false;
  private listScroll = 0;
  private detailScroll = 0;
  /** Narrow screens show the list or the thread, not both. */
  private detailOnly = false;
  /** The selection last rendered, to notice one made elsewhere (a gutter badge, the editor menu). */
  private shownSelection = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: EddiePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Eddie review";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("eddie-panel");
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Re-render, keeping scroll position and any text being typed. */
  refresh(): void {
    const el = this.contentEl;
    this.listScroll = el.querySelector<HTMLElement>(".eddie-list")?.scrollTop ?? this.listScroll;
    this.detailScroll = el.querySelector<HTMLElement>(".eddie-detail")?.scrollTop ?? this.detailScroll;
    const focused = el.querySelector<HTMLTextAreaElement>("textarea:focus");
    const focusId = focused?.dataset.draftFor;
    const caret = focused?.selectionStart;
    el.empty();
    this.render();
    el.querySelector<HTMLElement>(".eddie-list")?.scrollTo({ top: this.listScroll });
    el.querySelector<HTMLElement>(".eddie-detail")?.scrollTo({ top: this.detailScroll });
    if (focusId) {
      const t = el.querySelector<HTMLTextAreaElement>(`textarea[data-draft-for="${CSS.escape(focusId)}"]`);
      t?.focus();
      if (t && caret != null) t.setSelectionRange(caret, caret);
    }
  }

  private render(): void {
    const { plugin } = this;
    const adocPath = plugin.resolvedAdoc();
    const session = adocPath ? plugin.store.get(adocPath) : undefined;
    const el = this.contentEl;

    if (!adocPath || !session) {
      const empty = el.createDiv({ cls: "eddie-empty" });
      empty.createEl("p", { text: "No review loaded." });
      empty.createEl("p", {
        text: "Open an annotated PDF and map its comments onto an AsciiDoc file. Each PDF becomes one mapping in a review round; later rounds carry your resolved state forward.",
        cls: "eddie-muted",
      });
      empty.createEl("button", { text: "Open PDF review", cls: "mod-cta" }).addEventListener("click", () => void f.openReview(plugin, "ask"));
      return;
    }

    const high = plugin.settings.highConfidence;
    const all = plugin.settings.showResolved ? session.items : session.items.filter((i) => !i.resolved);
    const counts = countBuckets(all, high);

    // First open: land on the first remark nobody has answered, if asked to.
    if (!this.autoSelected && !plugin.selection && plugin.settings.expandThreads) {
      this.autoSelected = true;
      const first = session.items.find((i) => !i.resolved && !i.replies?.length);
      if (first) plugin.selection = { adocPath, id: first.id };
    }
    const sel = plugin.selection && plugin.selection.adocPath === adocPath ? plugin.selection : null;
    const selected = sel ? session.items.find((i) => i.id === sel.id) : undefined;
    const narrow = Platform.isMobile || el.clientWidth < 520;
    el.toggleClass("eddie-narrow", narrow);
    // A selection made outside the panel should show its thread, not just mark a row
    // in a list the user then has to click again.
    const selKey = selected ? `${adocPath}|${selected.id}` : "";
    if (selKey && selKey !== this.shownSelection && narrow) this.detailOnly = true;
    this.shownSelection = selKey;
    const showDetail = !!selected && (!narrow || this.detailOnly);
    const showList = !narrow || !this.detailOnly || !selected;

    this.renderHeader(el, adocPath, session);
    if (showList) this.renderFilters(el, counts, all);
    const body = el.createDiv({ cls: "eddie-body" });
    if (showList) this.renderList(body, all, selected?.id);
    if (showDetail && selected) this.renderDetail(body, adocPath, selected, narrow);
  }

  // -- header ---------------------------------------------------------------------

  private renderHeader(el: HTMLElement, adocPath: string, session: NonNullable<ReturnType<EddiePlugin["store"]["get"]>>): void {
    const { plugin } = this;
    const head = el.createDiv({ cls: "eddie-header" });
    const title = head.createDiv({ cls: "eddie-title" });
    title.createDiv({ cls: "eddie-doc", text: path.basename(adocPath) });
    const siblings = plugin.store.sessionsFor(adocPath);
    title.createDiv({
      cls: "eddie-muted",
      text: `${revisionLabel(session.revision)} · ${mappingLabel(session)}` + (siblings.length > 1 ? ` · ${siblings.length} mappings` : ""),
    });
    const actions = head.createDiv({ cls: "eddie-header-actions" });
    const btn = (icon: string, label: string, run: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      b.setText(icon);
      b.addEventListener("click", run);
      return b;
    };
    if (siblings.length > 1) btn("⇄", "Switch round or mapping", () => void f.switchMapping(plugin));
    btn("＋", "Add annotated PDF", () => void f.openReview(plugin, "ask"));
    btn("⋯", "More", () => this.moreMenu().showAtMouseEvent(new MouseEvent("click", { clientX: actions.getBoundingClientRect().right - 8, clientY: actions.getBoundingClientRect().bottom })));
  }

  private moreMenu(): Menu {
    const { plugin } = this;
    const m = new Menu();
    const item = (title: string, run: () => unknown) => m.addItem((i) => i.setTitle(title).onClick(() => void run()));
    item("Re-map annotations", () => f.remapAll(plugin));
    item("Triage unmatched…", () => f.triageUnmatched(plugin));
    item("Apply all confident edits…", () => f.applyAllConfident(plugin));
    m.addSeparator();
    item("Start new review round…", () => f.openReview(plugin, "new"));
    item("Add PDFs to this mapping…", () => f.appendPdfs(plugin));
    item("Merge mappings…", () => f.mergeMappings(plugin));
    item("Edit round details…", () => f.editMappingInfo(plugin));
    item("Remove this mapping…", () => f.deleteMapping(plugin));
    m.addSeparator();
    item("Export report", () => f.exportReport(plugin));
    item("Stamp reviewed PDF…", () => f.stampReviewedPdf(plugin));
    item("Extract annotations as AsciiDoc…", () => f.extractAnnotationsToAdoc(plugin));
    m.addSeparator();
    item("Anchor annotations in source", () => f.anchorSource(plugin));
    item("Remove source anchors", () => f.stripAnchors(plugin));
    item("Open review folder", () => f.openReviewFolder(plugin));
    return m;
  }

  // -- list -----------------------------------------------------------------------

  /** Persist the filters (UI state only; never written to a sidecar). */
  private save(): void {
    void this.plugin.savePanelState();
  }

  private renderFilters(
    el: HTMLElement,
    counts: ReturnType<typeof countBuckets>,
    items: ReviewItem[]
  ): void {
    const panel = this.plugin.panel;
    const hidden = new Set(panel.hidden);
    const bar = el.createDiv({ cls: "eddie-filters" });
    for (const b of BUCKET_ORDER) {
      const chip = bar.createEl("button", { cls: "eddie-chip", text: `${BUCKET_LABEL[b]} ${counts[b]}` });
      chip.toggleClass("is-off", hidden.has(b));
      chip.addEventListener("click", () => {
        if (hidden.has(b)) hidden.delete(b);
        else hidden.add(b);
        panel.hidden = [...hidden];
        this.save();
        this.refresh();
      });
    }

    // Narrow by kind or page, offering only values that exist in this review.
    const kinds = [...new Set(items.map((i) => i.kind))];
    const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
    const kindSel = bar.createEl("select", { cls: "dropdown eddie-select", attr: { "aria-label": "Filter by kind" } });
    kindSel.createEl("option", { text: "All kinds", value: "" });
    for (const k of kinds) kindSel.createEl("option", { text: KIND_LABEL[k], value: k });
    kindSel.value = kinds.includes(panel.kind as AnnotationKind) ? panel.kind : "";
    kindSel.addEventListener("change", () => {
      panel.kind = kindSel.value;
      this.save();
      this.refresh();
    });
    const pageSel = bar.createEl("select", { cls: "dropdown eddie-select", attr: { "aria-label": "Filter by page" } });
    pageSel.createEl("option", { text: "All pages", value: "" });
    for (const pg of pages) pageSel.createEl("option", { text: `Page ${pg}`, value: String(pg) });
    pageSel.value = pages.map(String).includes(panel.page) ? panel.page : "";
    pageSel.addEventListener("change", () => {
      panel.page = pageSel.value;
      this.save();
      this.refresh();
    });

    const search = bar.createEl("input", { type: "search", cls: "eddie-search", attr: { placeholder: "Filter…" } });
    search.value = panel.text;
    search.addEventListener("input", () => {
      panel.text = search.value;
      this.save();
      this.refresh();
      this.contentEl.querySelector<HTMLInputElement>(".eddie-search")?.focus();
    });
  }

  private renderList(body: HTMLElement, items: ReviewItem[], selectedId: string | undefined): void {
    const { plugin } = this;
    const high = plugin.settings.highConfidence;
    const panel = plugin.panel;
    const hidden = new Set(panel.hidden);
    const shown = applyFilter(
      items,
      {
        buckets: BUCKET_ORDER.filter((b) => !hidden.has(b)),
        text: panel.text,
        kinds: panel.kind ? [panel.kind as AnnotationKind] : undefined,
        page: panel.page ? Number(panel.page) : undefined,
      },
      high
    );
    const list = body.createDiv({ cls: "eddie-list" });
    if (!shown.length) {
      list.createDiv({ cls: "eddie-muted eddie-none", text: items.length ? "Nothing matches the filter." : "No annotations." });
      return;
    }
    for (const g of groupItems(shown, high)) {
      list.createDiv({ cls: "eddie-group", text: g.label });
      for (const it of g.items) {
        const row = list.createDiv({ cls: "eddie-row" });
        row.dataset.id = it.id;
        row.toggleClass("is-selected", it.id === selectedId);
        row.toggleClass("is-resolved", !!it.resolved);
        row.createSpan({ cls: "eddie-kind", text: KIND_LABEL[it.kind] });
        row.createSpan({ cls: "eddie-row-title", text: itemTitle(it) });
        const meta = [`p${it.page}`, isLocated(it) ? null : "no source match", it.stale ? "stale" : null, it.replies?.length ? `${it.replies.length} repl${it.replies.length === 1 ? "y" : "ies"}` : null]
          .filter(Boolean)
          .join(" · ");
        row.createDiv({ cls: "eddie-muted eddie-row-meta", text: meta });
        row.addEventListener("click", () => void this.pick(it));
      }
    }
  }

  private async pick(it: ReviewItem): Promise<void> {
    const { plugin } = this;
    const adocPath = plugin.resolvedAdoc();
    if (!adocPath) return;
    this.detailOnly = true;
    plugin.setSelection({ adocPath, id: it.id });
    if (isLocated(it)) await plugin.revealItem(adocPath, it.id);
    // Follow with the PDF once a preview is open, without taking focus from the list.
    if (plugin.previewLeaf?.view?.getViewType() === "pdf") void f.previewPdf(plugin, adocPath, it.id, false);
  }

  // -- thread ---------------------------------------------------------------------

  private renderDetail(body: HTMLElement, adocPath: string, item: ReviewItem, narrow: boolean): void {
    const { plugin } = this;
    const detail = body.createDiv({ cls: "eddie-detail" });
    if (narrow) {
      detail.createEl("button", { cls: "eddie-back", text: "‹ All annotations" }).addEventListener("click", () => {
        this.detailOnly = false;
        this.refresh();
      });
    }
    const ref = { adocPath, id: item.id };

    detail.createDiv({ cls: "eddie-thread-label", text: threadLabel(item) });
    if (item.stale) {
      detail.createDiv({
        cls: "eddie-warn",
        text: "Stale — the text this was linked to has changed. Confirm the match or re-link it.",
      });
    }

    const root = detail.createDiv({ cls: "eddie-post eddie-root" });
    root.createDiv({ cls: "eddie-post-author", text: markAuthor(item) });
    const rootBody = root.createDiv({ cls: "eddie-post-body markdown-rendered" });
    void MarkdownRenderer.render(plugin.app, rootMarkdown(item), rootBody, adocPath, this);

    for (const r of item.replies ?? []) {
      const post = detail.createDiv({ cls: "eddie-post" });
      const head = post.createDiv({ cls: "eddie-post-author" });
      head.createSpan({ text: r.author });
      head.createSpan({ cls: "eddie-muted", text: " · " + new Date(r.createdAt).toLocaleString() });
      if (this.editing?.id === item.id && this.editing.replyId === r.id) {
        const box = post.createEl("textarea", { cls: "eddie-reply-box" });
        box.value = r.body;
        const row = post.createDiv({ cls: "eddie-actions" });
        row.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => {
          plugin.store.editReply(adocPath, item.id, r.id, box.value);
          this.editing = null;
        });
        row.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
          this.editing = null;
          this.refresh();
        });
      } else {
        const b = post.createDiv({ cls: "eddie-post-body markdown-rendered" });
        void MarkdownRenderer.render(plugin.app, r.body, b, adocPath, this);
        if (r.author === plugin.settings.authorName.trim()) {
          const row = post.createDiv({ cls: "eddie-actions eddie-small" });
          row.createEl("button", { text: "Edit" }).addEventListener("click", () => {
            this.editing = { id: item.id, replyId: r.id };
            this.refresh();
          });
          row.createEl("button", { text: "Delete" }).addEventListener("click", () => plugin.store.deleteReply(adocPath, item.id, r.id));
        }
      }
    }

    // Reply box. The draft survives refreshes; Ctrl/Cmd+Enter sends.
    const box = detail.createEl("textarea", { cls: "eddie-reply-box", attr: { placeholder: "Reply…", rows: "3" } });
    box.dataset.draftFor = item.id;
    box.value = this.drafts.get(item.id) ?? "";
    box.addEventListener("input", () => this.drafts.set(item.id, box.value));
    const send = async () => {
      const text = box.value.trim();
      if (!text) return;
      if (await f.addReply(plugin, ref, text)) {
        this.drafts.delete(item.id);
        box.value = "";
      }
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    });
    detail.createEl("button", { text: "Reply", cls: "mod-cta eddie-send" }).addEventListener("click", () => void send());

    this.renderActions(detail, ref, item);
  }

  private renderActions(detail: HTMLElement, ref: { adocPath: string; id: string }, item: ReviewItem): void {
    const { plugin } = this;
    const located = isLocated(item);
    const bar = detail.createDiv({ cls: "eddie-actions" });
    const act = (label: string, run: () => unknown, cls = "") =>
      bar.createEl("button", { text: label, cls }).addEventListener("click", () => void run());

    act(item.resolved ? "Reopen" : "Resolve", () => f.toggleResolved(plugin, ref), item.resolved ? "" : "mod-cta");
    if (located && !item.confirmed) act("Confirm match", () => f.confirmMatch(plugin, ref));
    if (located) act("Reveal", () => plugin.revealItem(ref.adocPath, ref.id));
    act("Preview PDF", () => f.previewPdf(plugin, ref.adocPath, ref.id));
    act("Re-link to cursor", () => f.relinkToCursor(plugin, ref));
    act("Pick line…", () => f.relinkPick(plugin, ref));
    act("Re-map", () => f.remapItem(plugin, ref));

    const edits = availableActions(item, located);
    if (edits.length) {
      detail.createDiv({ cls: "eddie-muted eddie-edit-label", text: "Apply to the source" });
      const eb = detail.createDiv({ cls: "eddie-actions" });
      for (const a of edits) {
        eb.createEl("button", { text: a.label }).addEventListener("click", () => void f.applyAction(plugin, a.action, ref));
      }
    }
  }
}
