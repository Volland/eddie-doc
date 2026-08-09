import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type {
  RawAnnotation,
  Reply,
  ReviewItem,
  ReviewSession,
  SessionIntegrity,
} from "./types.js";
import { parse, serialize, sha256 } from "./format.js";
import { extractAnnotations } from "../pdf/extract.js";
import {
  effectiveLine,
  mapAnnotations,
  matchOne,
  type MapStats,
} from "../matching/mapper.js";
import {
  describeAnchor,
  findMarkers,
  injectMarkers,
  resolveAnchor,
  type MarkerTarget,
} from "../source/markers.js";
import { buildSourceIndex } from "../matching/fuzzyMatch.js";
import { lexicalFallback } from "../matching/lexical.js";
import { shiftLine, type ContentChange } from "../matching/posTrack.js";
import {
  FileEmbedCache,
  MemoryEmbedCache,
  semanticFallback,
  type EmbedCache,
} from "../matching/semantic.js";

/** Strip the review-state fields, leaving the raw annotation to re-map. */
function toRaw(it: ReviewItem): RawAnnotation {
  const {
    match,
    resolved,
    manualLine,
    confirmed,
    note,
    replies,
    anchor,
    ...raw
  } = it;
  void match;
  void resolved;
  void manualLine;
  void confirmed;
  void note;
  void replies;
  void anchor;
  return raw;
}

/** Sidecar path holding the persisted review for a given .adoc. */
export function sidecarPath(adocPath: string): string {
  return adocPath.replace(/\.adoc$/i, "") + ".review.json";
}

/** Short random id for a reply. Unique within a thread is all that is needed. */
function mintReplyId(): string {
  return "r-" + randomBytes(4).toString("hex");
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
  /** Embedding memo shared across maps; upgraded to a file cache on activate. */
  private embedCache: EmbedCache = new MemoryEmbedCache();

  /** Persist embeddings under `file` so re-maps across restarts skip Ollama. */
  useEmbedCacheFile(file: string): void {
    this.embedCache = new FileEmbedCache(file);
  }

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
    // Fingerprint BEFORE extraction. pdfjs used to detach this array (see
    // extract.ts), which turned the digest into the sha-256 of zero bytes and
    // silently disabled staleness detection. Hashing first makes that ordering
    // bug unrepresentable regardless of what the extractor does with the array.
    const pdfSha256 = sha256(bytes);
    const annots = await extractAnnotations(bytes);
    const prev = this.sessions.get(adocPath)?.items;
    const stats: MapStats = { carried: 0 };
    const items = mapAnnotations(annots, source, { threshold }, prev, stats);
    await this.runFallbacks(items, source);
    if (stats.carried > 0) {
      // A re-exported PDF re-keys every annotation id; content fingerprints
      // just rescued that state, and the user should know it survived.
      vscode.window.showInformationMessage(
        `Eddie Doc: carried review state for ${stats.carried} annotation(s) ` +
          `from the previous PDF round.`
      );
    }

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
        pdfSha256,
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
    await this.runFallbacks(items, source);
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

  /**
   * Rescue tiers for items the token matcher couldn't place: embeddings first
   * (highest quality, opt-in, needs Ollama), then the built-in character-
   * trigram lexical tier for whatever is still unmatched.
   */
  private async runFallbacks(
    items: ReviewItem[],
    source: string
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("eddieDoc");
    if (cfg.get<boolean>("semanticFallback", false)) {
      const url = cfg.get<string>("ollamaUrl", "http://localhost:11434");
      const model = cfg.get<string>("embedModel", "embeddinggemma");
      const threshold = cfg.get<number>("semanticThreshold", 0.62);
      const res = await semanticFallback(items, source, {
        url,
        model,
        threshold,
        cache: this.embedCache,
      });
      if (!res.ok && !this.semanticWarned) {
        this.semanticWarned = true;
        vscode.window.showWarningMessage(
          `Eddie Doc: semantic fallback couldn't reach Ollama at ${url}. ` +
            `Start Ollama (with the '${model}' model pulled) or disable eddieDoc.semanticFallback.`
        );
      }
    }
    if (cfg.get<boolean>("lexicalFallback", true)) {
      lexicalFallback(items, source, cfg.get<number>("lexicalThreshold", 0.6));
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

  /**
   * Append a reply to an item's thread. Replies are authored content — they are
   * never recomputed, and a re-map carries them across untouched.
   */
  addReply(adocPath: string, id: string, author: string, body: string): void {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    const text = body.trim();
    if (!text) return;
    const reply: Reply = {
      id: mintReplyId(),
      author,
      createdAt: new Date().toISOString(),
      body: text,
    };
    item.replies = [...(item.replies ?? []), reply];
    this.touch(adocPath);
  }

  /** Edit a reply's text in place, keeping its id and original timestamp. */
  editReply(
    adocPath: string,
    id: string,
    replyId: string,
    body: string
  ): void {
    const item = this.findItem(adocPath, id);
    const text = body.trim();
    if (!item?.replies || !text) return;
    const idx = item.replies.findIndex((r) => r.id === replyId);
    if (idx < 0) return;
    item.replies[idx] = { ...item.replies[idx], body: text };
    this.touch(adocPath);
  }

  /** Remove a reply. Drops the array entirely when the thread empties. */
  deleteReply(adocPath: string, id: string, replyId: string): void {
    const item = this.findItem(adocPath, id);
    if (!item?.replies) return;
    const left = item.replies.filter((r) => r.id !== replyId);
    if (left.length === item.replies.length) return;
    item.replies = left.length ? left : undefined;
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
    // Honour a recorded anchor here exactly as the bulk re-map does, or this
    // single-item action would silently downgrade an anchored item to a guess.
    const hit = resolveAnchor(source, item.anchor);
    if (hit) {
      item.match = {
        startLine: hit.line,
        endLine: hit.endLine,
        score: 1,
        method: hit.method,
        sourceExcerpt: hit.excerpt.slice(0, 200),
      };
      item.manualLine = undefined;
      item.confirmed = true; // a resolved identity is not a guess
      this.touch(adocPath);
      return;
    }
    const idx = buildSourceIndex(source);
    item.match = matchOne(item, idx, threshold);
    item.manualLine = undefined;
    item.confirmed = false; // fresh auto-match — back up for review
    this.touch(adocPath);
  }

  /**
   * Inject `// eddie:<id>` markers into the source for every item that has a
   * location, and record the resulting anchors. Returns the rewritten source
   * for the caller to apply as a workspace edit — this method deliberately does
   * NOT write the file, so anchoring stays a single undoable editor action.
   *
   * Anchoring is always explicit: loading and re-mapping never touch the
   * manuscript.
   */
  buildAnchors(
    adocPath: string,
    source: string
  ): { source: string; inserted: number; anchored: number } | undefined {
    const session = this.sessions.get(adocPath);
    if (!session) return undefined;

    const targets: MarkerTarget[] = [];
    for (const it of session.items) {
      const line = effectiveLine(it);
      if (line === Number.MAX_SAFE_INTEGER) continue; // unmatched — nothing to anchor
      targets.push({ itemId: it.id, line });
    }
    if (!targets.length) return { source, inserted: 0, anchored: 0 };

    const res = injectMarkers(source, targets);
    // Describe each anchor against the REWRITTEN source so block fingerprints
    // and context reflect what will actually be on disk.
    const markers = findMarkers(res.source);
    let anchored = 0;
    for (const it of session.items) {
      const markerId = res.assigned.get(it.id);
      if (!markerId) continue;
      const hit = markers.get(markerId);
      if (!hit) continue;
      it.anchor = describeAnchor(res.source, hit.targetLine, markerId);
      anchored++;
    }
    return { source: res.source, inserted: res.inserted, anchored };
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
