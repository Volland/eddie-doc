import { ItemView, Notice, Platform, type WorkspaceLeaf } from "obsidian";
import type EddiePlugin from "../main.js";
import { openPreviewDocument, type PreviewDocument } from "../pdf/engine.js";
import * as path from "../../../core/util/path.js";

export const PDF_PREVIEW_VIEW_TYPE = "eddie-pdf-preview";

/**
 * Eddie's own PDF page view: draws one page and a rectangle over the marked text.
 *
 * It exists for the case where Obsidian's built-in viewer does not highlight the
 * rectangle (or highlights it in the wrong place). It does not depend on how that
 * viewer treats `&rect=`: the rectangle is converted by pdfjs's own viewport
 * transform, which already accounts for the page's origin and rotation. One
 * canvas is kept; it is redrawn, not stacked, when the page changes, and the scale
 * is capped on mobile.
 */
export class PdfPreviewView extends ItemView {
  private doc: PreviewDocument | undefined;
  private current: { path: string; page: number; rect?: number[] } | undefined;
  private token = 0;
  // Named to avoid Obsidian's own View members (titleEl, headerEl, containerEl, contentEl…):
  // a field with the same name replaces the base class's and breaks opening the view.
  private nameLabel!: HTMLElement;
  private pageLabel!: HTMLElement;
  private scrollEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: EddiePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return PDF_PREVIEW_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.current ? `Eddie · ${path.basename(this.current.path)}` : "Eddie PDF preview";
  }
  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("eddie-pdfview");
    const bar = el.createDiv({ cls: "eddie-pdfview-bar" });
    this.nameLabel = bar.createSpan({ cls: "eddie-pdfview-title" });
    const prev = bar.createEl("button", { text: "‹", attr: { "aria-label": "Previous page" } });
    this.pageLabel = bar.createSpan({ cls: "eddie-muted" });
    const next = bar.createEl("button", { text: "›", attr: { "aria-label": "Next page" } });
    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    this.scrollEl = el.createDiv({ cls: "eddie-pdfview-scroll" });
  }

  async onClose(): Promise<void> {
    this.token++;
    await this.closeDoc();
    this.contentEl.empty();
  }

  private async closeDoc(): Promise<void> {
    const d = this.doc;
    this.doc = undefined;
    try {
      await d?.destroy();
    } catch {
      /* already gone */
    }
  }

  /** Show `page` of `pdfPath`, with `rect` (PDF user space) outlined when given. */
  async show(pdfPath: string, page: number, rect?: number[]): Promise<void> {
    const mine = ++this.token;
    if (this.current?.path !== pdfPath) {
      await this.closeDoc();
      const bytes = await this.plugin.host.storage.readBytes(pdfPath);
      const doc = await openPreviewDocument(bytes);
      if (mine !== this.token) return void doc.destroy().catch(() => undefined);
      this.doc = doc;
    }
    this.current = { path: pdfPath, page, rect };
    await this.draw(mine);
  }

  private step(by: number): void {
    const c = this.current;
    if (!c || !this.doc) return;
    const page = Math.min(this.doc.numPages, Math.max(1, c.page + by));
    if (page === c.page) return;
    const mine = ++this.token;
    this.current = { path: c.path, page }; // no rectangle on a page that is not the annotation's
    void this.draw(mine);
  }

  private async draw(mine: number): Promise<void> {
    const c = this.current;
    const doc = this.doc;
    if (!c || !doc) return;
    try {
      const page = await doc.getPage(c.page);
      if (mine !== this.token) return;
      const width = Math.max(this.scrollEl.clientWidth, 280);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(activeWindow.devicePixelRatio || 1, Platform.isMobile ? 2 : 3);
      const fit = Math.min(width / base.width, Platform.isMobile ? 2 : 3);
      const viewport = page.getViewport({ scale: fit * dpr });

      const canvas = activeDocument.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setCssStyles({ width: `${viewport.width / dpr}px`, height: `${viewport.height / dpr}px` });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d canvas");
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup?.();
      if (mine !== this.token) return;

      this.scrollEl.empty();
      const holder = this.scrollEl.createDiv({ cls: "eddie-pdfview-page" });
      holder.appendChild(canvas);
      if (c.rect) {
        const r = viewport.convertToViewportRectangle(c.rect);
        const box = holder.createDiv({ cls: "eddie-pdfview-mark" });
        box.setCssStyles({
          left: `${Math.min(r[0], r[2]) / dpr}px`,
          top: `${Math.min(r[1], r[3]) / dpr}px`,
          width: `${Math.abs(r[2] - r[0]) / dpr}px`,
          height: `${Math.abs(r[3] - r[1]) / dpr}px`,
        });
        box.scrollIntoView({ block: "center", behavior: "auto" });
      }
      this.nameLabel.setText(path.basename(c.path));
      this.pageLabel.setText(`${c.page} / ${doc.numPages}`);
    } catch (e) {
      if (mine !== this.token) return;
      new Notice(`Eddie Doc: could not draw the PDF page — ${String(e)}`, 8000);
    }
  }
}
