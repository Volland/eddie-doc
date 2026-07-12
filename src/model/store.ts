import * as fs from "node:fs";
import * as vscode from "vscode";
import type {
  RawAnnotation,
  ReviewItem,
  ReviewSession,
  SessionIntegrity,
} from "./types.js";
import { parse, serialize, sha256 } from "./format.js";
import { extractAnnotations } from "../pdf/extract.js";
import { mapAnnotations, matchOne } from "../matching/mapper.js";
import { buildSourceIndex } from "../matching/fuzzyMatch.js";
import { shiftLine, type ContentChange } from "../matching/posTrack.js";
import { semanticFallback } from "../matching/semantic.js";

/** Strip the review-state fields, leaving the raw annotation to re-map. */
function toRaw(it: ReviewItem): RawAnnotation {
  const { match, resolved, manualLine, confirmed, note, ...raw } = it;
  void match;
  void resolved;
  void manualLine;
  void confirmed;
  void note;
  return raw;
}

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
  /** Only nag once per session if the semantic backend is unreachable. */
  private semanticWarned = false;

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
      const session = parse(fs.readFileSync(p, "utf8"), p, adocPath);
      if (session) {
        this.sessions.set(adocPath, session);
        this._onDidChange.fire(adocPath);
        return session;
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
    const sourceBytes = fs.readFileSync(adocPath);
    const source = sourceBytes.toString("utf8");
    const annots = await extractAnnotations(bytes);
    const prev = this.sessions.get(adocPath)?.items;
    const items = mapAnnotations(annots, source, { threshold }, prev);
    await this.runSemantic(items, source);

    const now = new Date().toISOString();
    const session: ReviewSession = {
      version: 2,
      adocPath,
      pdfPath,
      createdAt: this.sessions.get(adocPath)?.createdAt ?? now,
      updatedAt: now,
      integrity: {
        sourceSha256: sha256(new Uint8Array(sourceBytes)),
        sourceBytes: sourceBytes.length,
        pdfSha256: sha256(bytes),
        pdfAnnotationCount: annots.length,
      },
      items,
    };
    this.sessions.set(adocPath, session);
    this.persist(adocPath);
    this._onDidChange.fire(adocPath);
    return session;
  }

  /**
   * Re-run matching against the current source text (e.g. after edits). Reuses
   * the annotations already extracted from the PDF — no re-read of the PDF, so
   * it's cheap and works even if the PDF has since moved.
   */
  async remap(adocPath: string, threshold: number): Promise<void> {
    const session = this.sessions.get(adocPath);
    if (!session) return;
    const sourceBytes = fs.readFileSync(adocPath);
    const source = sourceBytes.toString("utf8");
    const raw = session.items.map(toRaw);
    const items = mapAnnotations(raw, source, { threshold }, session.items);
    await this.runSemantic(items, source);
    session.items = items;
    session.version = 2;
    session.updatedAt = new Date().toISOString();
    session.integrity = {
      ...session.integrity,
      sourceSha256: sha256(new Uint8Array(sourceBytes)),
      sourceBytes: sourceBytes.length,
    } satisfies SessionIntegrity;
    this.persist(adocPath);
    this._onDidChange.fire(adocPath);
  }

  /** Apply the optional embedding-based fallback when the user has enabled it. */
  private async runSemantic(
    items: ReviewItem[],
    source: string
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("eddieDoc");
    if (!cfg.get<boolean>("semanticFallback", false)) return;
    const url = cfg.get<string>("ollamaUrl", "http://localhost:11434");
    const model = cfg.get<string>("embedModel", "embeddinggemma");
    const threshold = cfg.get<number>("semanticThreshold", 0.62);
    const res = await semanticFallback(items, source, { url, model, threshold });
    if (!res.ok && !this.semanticWarned) {
      this.semanticWarned = true;
      vscode.window.showWarningMessage(
        `Eddie Doc: semantic fallback couldn't reach Ollama at ${url}. ` +
          `Start Ollama (with the '${model}' model pulled) or disable eddieDoc.semanticFallback.`
      );
    }
  }

  /**
   * Shift every annotation's line anchors through a batch of document edits so
   * positions stay live between saves. In-memory only (no persist / event) — the
   * caller drives UI updates; the save-time remap persists the reconciled state.
   * Returns true if anything moved.
   */
  shiftPositions(adocPath: string, changes: ContentChange[]): boolean {
    const s = this.sessions.get(adocPath);
    if (!s || changes.length === 0) return false;
    let moved = false;
    for (const it of s.items) {
      if (it.manualLine != null) {
        const n = shiftLine(it.manualLine, changes);
        if (n !== it.manualLine) {
          it.manualLine = n;
          moved = true;
        }
      }
      if (it.match) {
        const ns = shiftLine(it.match.startLine, changes);
        const ne = shiftLine(it.match.endLine, changes);
        if (ns !== it.match.startLine || ne !== it.match.endLine) {
          it.match = { ...it.match, startLine: ns, endLine: ne };
          moved = true;
        }
      }
    }
    return moved;
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
    item.confirmed = true; // a hand-picked line is trusted
    this.touch(adocPath);
  }

  /** Mark an auto/semantic match as vouched-for so it leaves "Needs review". */
  confirmMatch(adocPath: string, id: string): void {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    item.confirmed = true;
    this.touch(adocPath);
  }

  /**
   * Re-run automatic matching for a single annotation against the current source
   * text, dropping any manual override. Returns the resulting effective match
   * (null when nothing clears the threshold).
   */
  remapItem(adocPath: string, id: string, threshold: number): void {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    const source = fs.readFileSync(adocPath, "utf8");
    const idx = buildSourceIndex(source);
    item.match = matchOne(item, idx, threshold);
    item.manualLine = undefined;
    item.confirmed = false; // fresh auto-match — back up for review
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
    const p = sidecarPath(adocPath);
    try {
      // Any write upgrades the sidecar to the current on-disk standard.
      s.version = 2;
      fs.writeFileSync(p, serialize(s, p), "utf8");
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
