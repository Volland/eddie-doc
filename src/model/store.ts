import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ReviewItem, ReviewSession } from "./types.js";
import { extractAnnotations } from "../pdf/extract.js";
import { mapAnnotations } from "../matching/mapper.js";

/** Sidecar path holding the persisted review for a given .adoc. */
export function sidecarPath(adocPath: string): string {
  return adocPath.replace(/\.adoc$/i, "") + ".review.json";
}

/**
 * Owns the in-memory review sessions (one per .adoc) and their sidecar files.
 * Emits a change event whenever a session is loaded or mutated so the tree and
 * decorations can refresh.
 */
export class ReviewStore {
  private sessions = new Map<string, ReviewSession>();
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  /** Fires with the affected adocPath, or undefined for a broad refresh. */
  readonly onDidChange = this._onDidChange.event;

  get(adocPath: string): ReviewSession | undefined {
    return this.sessions.get(adocPath);
  }

  all(): ReviewSession[] {
    return [...this.sessions.values()];
  }

  /** Load any previously-persisted session from disk (called on activation). */
  tryLoadSidecar(adocPath: string): ReviewSession | undefined {
    const p = sidecarPath(adocPath);
    if (!fs.existsSync(p)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as ReviewSession;
      if (data && data.version === 1) {
        this.sessions.set(adocPath, data);
        this._onDidChange.fire(adocPath);
        return data;
      }
    } catch {
      /* corrupt sidecar — ignore, user can re-map */
    }
    return undefined;
  }

  /** Extract annotations from a PDF and (re-)map them onto the source. */
  async loadReview(
    adocPath: string,
    pdfPath: string,
    threshold: number
  ): Promise<ReviewSession> {
    const bytes = new Uint8Array(fs.readFileSync(pdfPath));
    const source = fs.readFileSync(adocPath, "utf8");
    const annots = await extractAnnotations(bytes);
    const prev = this.sessions.get(adocPath)?.items;
    const items = mapAnnotations(annots, source, { threshold }, prev);

    const now = new Date().toISOString();
    const session: ReviewSession = {
      version: 1,
      adocPath,
      pdfPath,
      createdAt: this.sessions.get(adocPath)?.createdAt ?? now,
      updatedAt: now,
      items,
    };
    this.sessions.set(adocPath, session);
    this.persist(adocPath);
    this._onDidChange.fire(adocPath);
    return session;
  }

  /** Re-run matching against the current source text (e.g. after edits). */
  async remap(adocPath: string, threshold: number): Promise<void> {
    const session = this.sessions.get(adocPath);
    if (!session) return;
    await this.loadReview(adocPath, session.pdfPath, threshold);
  }

  findItem(adocPath: string, id: string): ReviewItem | undefined {
    return this.sessions.get(adocPath)?.items.find((i) => i.id === id);
  }

  toggleResolved(adocPath: string, id: string): void {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    item.resolved = !item.resolved;
    this.touch(adocPath);
  }

  relink(adocPath: string, id: string, line: number): void {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    item.manualLine = line;
    this.touch(adocPath);
  }

  private touch(adocPath: string): void {
    const s = this.sessions.get(adocPath);
    if (!s) return;
    s.updatedAt = new Date().toISOString();
    this.persist(adocPath);
    this._onDidChange.fire(adocPath);
  }

  private persist(adocPath: string): void {
    const s = this.sessions.get(adocPath);
    if (!s) return;
    try {
      fs.writeFileSync(sidecarPath(adocPath), JSON.stringify(s, null, 2), "utf8");
    } catch (e) {
      vscode.window.showWarningMessage(
        `Eddie Doc: could not save review sidecar: ${String(e)}`
      );
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
