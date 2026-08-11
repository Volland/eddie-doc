import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  Artifact,
  MappingInfo,
  PdfInfo,
  PdfRole,
  RawAnnotation,
  Reply,
  ReviewItem,
  ReviewSession,
  RevisionInfo,
  SessionIntegrity,
} from "./types.js";
import { parse, resolveSourcePath, serialize, sha256 } from "./format.js";
import {
  documentFolder,
  legacySidecarPath,
  mappingIdFromPdf,
  mappingSidecarPath,
  pdfFolder,
  revisionId as revisionIdFor,
  uniqueId,
  type LayoutConfig,
} from "./layout.js";
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

/** Short random id for a reply. Unique within a thread is all that is needed. */
function mintReplyId(): string {
  return "r-" + randomBytes(4).toString("hex");
}

/** Compare two paths as the file system would address them. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** Create `dir` and any missing parents. */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Everything a new mapping needs beyond its two input files. */
export interface LoadReviewOptions {
  threshold: number;
  /**
   * The round this mapping belongs to. Defaults to the document's newest
   * revision, so adding a second editor's PDF joins the round in progress
   * rather than silently starting another one.
   */
  revision?: RevisionInfo;
  /** Overwrite this exact mapping (re-binding it to a different PDF). */
  sidecarPath?: string;
  /** Descriptive metadata for the mapping; the id is minted when absent. */
  mapping?: Partial<MappingInfo>;
  /** What kind of PDF is being mapped. Defaults to `annotated`. */
  pdfRole?: PdfRole;
  /** Copy the PDF into the revision's `pdf/` folder and map the copy. */
  importPdf?: boolean;
}

/** What a legacy-sidecar migration would do, per file. */
export interface MigrationStep {
  from: string;
  to: string;
  adocPath: string;
}

/**
 * Owns the in-memory review sessions and their sidecar files, and emits a change
 * event whenever one is loaded or mutated so the tree and decorations refresh.
 *
 * A document has **many** sessions: one per mapping, grouped into revisions
 * (see `model/layout.ts`). Exactly one of them is *active* per document, and the
 * per-document API — `get`, `remap`, `toggleResolved` and the rest — addresses
 * that one, so the UI stays bound to a single mapping at a time. The multi-
 * mapping surface (`sessionsFor`, `revisionsFor`, `setActive`) is what the
 * revision switcher drives.
 */
export class ReviewStore {
  /** Every loaded mapping, keyed by the absolute path of its sidecar. */
  private sessions = new Map<string, ReviewSession>();
  /** The mapping each document is currently showing: adocPath -> sidecarPath. */
  private activeByDoc = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  /** Fires with the affected adocPath, or undefined for a broad refresh. */
  readonly onDidChange = this._onDidChange.event;
  /** Only nag once per session if the semantic backend is unreachable. */
  private semanticWarned = false;
  /** Embedding memo shared across maps; upgraded to a file cache on activate. */
  private embedCache: EmbedCache = new MemoryEmbedCache();
  /** Where review artifacts live. Set on activation, and on settings changes. */
  private layout: LayoutConfig = { reviewFolder: "" };

  /** Persist embeddings under `file` so re-maps across restarts skip Ollama. */
  useEmbedCacheFile(file: string): void {
    this.embedCache = new FileEmbedCache(file);
  }

  /** Point the store at the configured review folder. */
  configure(layout: LayoutConfig): void {
    this.layout = layout;
  }

  get layoutConfig(): LayoutConfig {
    return this.layout;
  }

  // -- lookup ---------------------------------------------------------------

  /** The mapping a document is currently showing. */
  get(adocPath: string): ReviewSession | undefined {
    const key = this.activeByDoc.get(path.resolve(adocPath));
    if (key) {
      const s = this.sessions.get(key);
      if (s) return s;
      this.activeByDoc.delete(path.resolve(adocPath));
    }
    // No explicit choice (or it went away): fall back to the newest mapping.
    const all = this.sessionsFor(adocPath);
    const pick = all[all.length - 1];
    if (pick) this.activeByDoc.set(path.resolve(adocPath), pick.sidecarPath);
    return pick;
  }

  getBySidecar(sidecarPath: string): ReviewSession | undefined {
    return this.sessions.get(path.resolve(sidecarPath));
  }

  /** Every loaded mapping, across documents and revisions. */
  all(): ReviewSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Every mapping of one document, oldest round first and, within a round, in
   * the order the mappings were added.
   */
  sessionsFor(adocPath: string): ReviewSession[] {
    return this.all()
      .filter((s) => s.adocPath && samePath(s.adocPath, adocPath))
      .sort(
        (a, b) =>
          a.revision.ordinal - b.revision.ordinal ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.mapping.id.localeCompare(b.mapping.id)
      );
  }

  /** The distinct revisions of a document, oldest first. */
  revisionsFor(adocPath: string): RevisionInfo[] {
    const byId = new Map<string, RevisionInfo>();
    for (const s of this.sessionsFor(adocPath)) {
      if (!byId.has(s.revision.id)) byId.set(s.revision.id, s.revision);
    }
    return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  /** The newest round of a document, or undefined when it has none. */
  latestRevision(adocPath: string): RevisionInfo | undefined {
    const revs = this.revisionsFor(adocPath);
    return revs[revs.length - 1];
  }

  /** The round a *new* mapping would start: one past the newest. */
  nextRevision(adocPath: string): RevisionInfo {
    const ordinal = (this.latestRevision(adocPath)?.ordinal ?? 0) + 1;
    return { id: revisionIdFor(ordinal), ordinal };
  }

  /** Documents with at least one loaded mapping. */
  documents(): string[] {
    const seen = new Set<string>();
    for (const s of this.all()) if (s.adocPath) seen.add(s.adocPath);
    return [...seen];
  }

  /** Show `sidecarPath` for its document. Returns false if it isn't loaded. */
  setActive(sidecarPath: string): boolean {
    const s = this.getBySidecar(sidecarPath);
    if (!s) return false;
    this.activeByDoc.set(path.resolve(s.adocPath), path.resolve(sidecarPath));
    this._onDidChange.fire(s.adocPath);
    return true;
  }

  /** The mapping holding `id`, wherever it lives. */
  locate(id: string): ReviewSession | undefined {
    // Prefer the active mapping: annotation ids repeat across rounds, and the
    // one the user is looking at is the one they mean.
    for (const key of this.activeByDoc.values()) {
      const s = this.sessions.get(key);
      if (s?.items.some((i) => i.id === id)) return s;
    }
    return this.all().find((s) => s.items.some((i) => i.id === id));
  }

  // -- loading --------------------------------------------------------------

  /**
   * Load every persisted mapping for `adocPath`: the legacy sidecar beside it,
   * plus everything under its folder in the review tree. Returns the active one.
   */
  tryLoadSidecar(adocPath: string): ReviewSession | undefined {
    let loaded = false;
    const legacy = legacySidecarPath(adocPath);
    if (!this.sessions.has(path.resolve(legacy)) && fs.existsSync(legacy)) {
      loaded = !!this.loadSidecarFile(legacy, adocPath) || loaded;
    }
    for (const file of this.discoverSidecars(adocPath)) {
      if (this.sessions.has(path.resolve(file))) continue;
      loaded = !!this.loadSidecarFile(file, adocPath) || loaded;
    }
    if (loaded) this._onDidChange.fire(adocPath);
    return this.get(adocPath);
  }

  /** Sidecar files under a document's folder in the review tree. */
  private discoverSidecars(adocPath: string): string[] {
    const folder = documentFolder(this.layout, adocPath);
    if (!folder || !fs.existsSync(folder)) return [];
    const out: string[] = [];
    for (const rev of readDirSafe(folder)) {
      const revDir = path.join(folder, rev);
      if (!isDir(revDir)) continue;
      for (const f of readDirSafe(revDir)) {
        if (/\.review\.json$/i.test(f)) out.push(path.join(revDir, f));
      }
    }
    return out.sort();
  }

  /**
   * Read one sidecar into the store. `adocPath` binds it to a known source; when
   * omitted the file's own recorded source path is used, which is how discovery
   * finds the manuscript for a sidecar living under the review folder.
   */
  loadSidecarFile(
    sidecarPath: string,
    adocPath?: string
  ): ReviewSession | undefined {
    try {
      const text = fs.readFileSync(sidecarPath, "utf8");
      const bound = adocPath ?? resolveSourcePath(text, sidecarPath);
      if (!bound || !fs.existsSync(bound)) return undefined;
      const session = parse(text, sidecarPath, bound);
      if (!session) return undefined;
      session.sidecarPath = path.resolve(sidecarPath);
      this.sessions.set(session.sidecarPath, session);
      return session;
    } catch {
      /* corrupt or unreadable sidecar — ignore, the user can re-map */
      return undefined;
    }
  }

  /**
   * Extract annotations from a PDF and map them onto the source as a mapping of
   * one revision.
   *
   * Review state carries over from the previous round automatically: annotation
   * ids are re-keyed by every PDF export, so the matcher reattaches state by
   * content fingerprint. The mapping it carries from is the same editor's work
   * in the previous round when the origins agree, else that round's newest.
   */
  async loadReview(
    adocPath: string,
    pdfPath: string,
    opts: LoadReviewOptions
  ): Promise<ReviewSession> {
    const revision =
      opts.revision ?? this.latestRevision(adocPath) ?? this.nextRevision(adocPath);
    const existing = opts.sidecarPath
      ? this.getBySidecar(opts.sidecarPath)
      : undefined;

    const mappingId =
      existing?.mapping.id ??
      opts.mapping?.id ??
      this.mintMappingId(adocPath, revision, pdfPath);
    const sidecar =
      opts.sidecarPath ??
      this.sidecarPathFor(adocPath, revision, mappingId);

    // Importing copies the PDF next to its mapping so a round stays readable
    // after the download folder it arrived in is cleared out.
    let mappedPdf = pdfPath;
    const pdfInfo: PdfInfo = { role: opts.pdfRole ?? "annotated" };
    if (opts.importPdf) {
      const copied = this.importPdf(adocPath, revision, mappingId, pdfPath);
      if (copied) {
        mappedPdf = copied;
        pdfInfo.imported = true;
        pdfInfo.importedFrom = pdfPath;
      }
    }

    const bytes = new Uint8Array(fs.readFileSync(mappedPdf));
    const sourceBytes = fs.readFileSync(adocPath);
    const source = sourceBytes.toString("utf8");
    // Fingerprint BEFORE extraction. pdfjs used to detach this array (see
    // extract.ts), which turned the digest into the sha-256 of zero bytes and
    // silently disabled staleness detection. Hashing first makes that ordering
    // bug unrepresentable regardless of what the extractor does with the array.
    const pdfSha256 = sha256(bytes);
    const annots = await extractAnnotations(bytes);
    const prev =
      existing?.items ??
      this.carrySource(adocPath, revision, opts.mapping?.origin)?.items;
    const stats: MapStats = { carried: 0 };
    const items = mapAnnotations(
      annots,
      source,
      { threshold: opts.threshold },
      prev,
      stats
    );
    await this.runFallbacks(items, source);
    if (stats.carried > 0) {
      // A re-exported PDF re-keys every annotation id; content fingerprints
      // just rescued that state, and the user should know it survived.
      vscode.window.showInformationMessage(
        `Eddie Doc: carried review state for ${stats.carried} annotation(s) ` +
          `from the previous round.`
      );
    }

    const now = new Date().toISOString();
    const session: ReviewSession = {
      version: 3,
      sidecarPath: path.resolve(sidecar),
      adocPath,
      pdfPath: mappedPdf,
      revision,
      mapping: {
        kind: "annotations",
        createdAt: now,
        // Re-mapping an existing mapping keeps what the author already told us
        // about it; the options only override what they just said again.
        ...(existing ? stripUndefined(existing.mapping) : {}),
        ...stripUndefined(opts.mapping ?? {}),
        // The id names the file, so it is decided above, never by the options.
        id: mappingId,
      },
      pdf: pdfInfo,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      integrity: {
        sourceSha256: sha256(new Uint8Array(sourceBytes)),
        sourceBytes: sourceBytes.length,
        pdfSha256,
        pdfAnnotationCount: annots.length,
      },
      artifacts: existing?.artifacts,
      items,
    };
    this.sessions.set(session.sidecarPath, session);
    this.activeByDoc.set(path.resolve(adocPath), session.sidecarPath);
    this.persist(session);
    this._onDidChange.fire(adocPath);
    return session;
  }

  /** The mapping a new one in `revision` should inherit review state from. */
  private carrySource(
    adocPath: string,
    revision: RevisionInfo,
    origin?: string
  ): ReviewSession | undefined {
    const earlier = this.sessionsFor(adocPath).filter(
      (s) => s.revision.ordinal < revision.ordinal
    );
    if (!earlier.length) return undefined;
    const newest = earlier[earlier.length - 1].revision.ordinal;
    const lastRound = earlier.filter((s) => s.revision.ordinal === newest);
    if (origin) {
      const sameEditor = lastRound.find(
        (s) => s.mapping.origin?.toLowerCase() === origin.toLowerCase()
      );
      if (sameEditor) return sameEditor;
    }
    return lastRound
      .slice()
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .pop();
  }

  /** A mapping id free within its revision folder. */
  mintMappingId(
    adocPath: string,
    revision: RevisionInfo,
    pdfPath: string
  ): string {
    const taken = this.sessionsFor(adocPath)
      .filter((s) => s.revision.id === revision.id)
      .map((s) => s.mapping.id);
    return mappingIdFromPdf(pdfPath, taken);
  }

  /**
   * Where a mapping's sidecar belongs. With a review folder configured that is
   * inside the revision's folder; without one it falls back to the historical
   * `<file>.review.json` beside the manuscript, which supports only one mapping
   * — so a second one is disambiguated by its id.
   */
  sidecarPathFor(
    adocPath: string,
    revision: RevisionInfo,
    mappingId: string
  ): string {
    const folder = documentFolder(this.layout, adocPath);
    if (folder) return mappingSidecarPath(folder, revision.id, mappingId);
    const legacy = legacySidecarPath(adocPath);
    const isFirst = revision.ordinal === 1 && !this.sessionsFor(adocPath).length;
    if (isFirst) return legacy;
    return legacy.replace(
      /\.review\.json$/i,
      `.${revision.id}-${mappingId}.review.json`
    );
  }

  /** Copy an annotated PDF in beside its mapping. Returns the new path. */
  private importPdf(
    adocPath: string,
    revision: RevisionInfo,
    mappingId: string,
    pdfPath: string
  ): string | undefined {
    const folder = documentFolder(this.layout, adocPath);
    if (!folder) return undefined;
    const dir = pdfFolder(folder, revision.id);
    const target = path.join(dir, `${mappingId}.pdf`);
    try {
      if (samePath(target, pdfPath)) return target;
      ensureDir(dir);
      fs.copyFileSync(pdfPath, target);
      return target;
    } catch (e) {
      vscode.window.showWarningMessage(
        `Eddie Doc: could not import the PDF into the review folder — ${String(e)}`
      );
      return undefined;
    }
  }

  /**
   * Re-run matching against the current source text (e.g. after edits) for the
   * document's active mapping. Reuses the annotations already extracted from the
   * PDF — no re-read of the PDF, so it's cheap and works even if the PDF moved.
   */
  async remap(adocPath: string, threshold: number): Promise<void> {
    const session = this.get(adocPath);
    if (!session) return;
    await this.remapSession(session, threshold, false);
    this._onDidChange.fire(adocPath);
  }

  /**
   * Re-map every loaded mapping of a document, not just the active one, and
   * report how many were re-derived.
   *
   * `onlyIfSourceChanged` is for the automatic pass on save: with autosave on,
   * "on save" means "every second while the author types", and each pass used to
   * re-run the matcher over every round and rewrite every sidecar even when the
   * text was byte-for-byte what those positions were already matched against.
   */
  async remapAll(
    adocPath: string,
    threshold: number,
    opts: { onlyIfSourceChanged?: boolean } = {}
  ): Promise<number> {
    let remapped = 0;
    for (const s of this.sessionsFor(adocPath)) {
      const did = await this.remapSession(
        s,
        threshold,
        opts.onlyIfSourceChanged ?? false
      );
      if (did) remapped++;
    }
    // One event for the document, not one per round. Firing per round meant the
    // tree, the decorations and the comment threads rebuilt N times per save —
    // and, while the loop was walking the rounds, rendered whichever round it
    // had made active on the way past. That is what made the UI jump.
    if (remapped > 0) this._onDidChange.fire(adocPath);
    return remapped;
  }

  /**
   * Re-derive one mapping's positions from the source on disk. Silent by
   * design: the caller decides when — and how often — the UI hears about it.
   * Returns whether anything was re-mapped.
   */
  private async remapSession(
    session: ReviewSession,
    threshold: number,
    skipUnchangedSource: boolean
  ): Promise<boolean> {
    const sourceBytes = fs.readFileSync(session.adocPath);
    const sha = sha256(new Uint8Array(sourceBytes));
    if (skipUnchangedSource && session.integrity?.sourceSha256 === sha) {
      return false;
    }
    const source = sourceBytes.toString("utf8");
    const raw = session.items.map(toRaw);
    const items = mapAnnotations(raw, source, { threshold }, session.items);
    await this.runFallbacks(items, source);
    session.items = items;
    session.version = 3;
    session.updatedAt = new Date().toISOString();
    session.integrity = {
      ...session.integrity,
      sourceSha256: sha,
      sourceBytes: sourceBytes.length,
    } satisfies SessionIntegrity;
    this.persist(session);
    return true;
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

  // -- mapping lifecycle ----------------------------------------------------

  /**
   * Update a mapping's descriptive metadata.
   *
   * A key present with an `undefined` value **clears** that field — that is how
   * the UI empties a label the author no longer wants. Absent keys are left
   * alone, and the id is never touched: it names the file.
   */
  describeMapping(
    sidecarPath: string,
    patch: Partial<MappingInfo> & {
      revision?: Partial<RevisionInfo>;
      pdfRole?: PdfRole;
    }
  ): void {
    const s = this.getBySidecar(sidecarPath);
    if (!s) return;
    const { revision, pdfRole, ...mapping } = patch;
    s.mapping = { ...s.mapping, ...mapping, id: s.mapping.id };
    if (revision) {
      const updated = { ...s.revision, ...revision, id: s.revision.id };
      // A round is shared: renaming it renames it for every mapping in it.
      for (const sibling of this.sessionsFor(s.adocPath)) {
        if (sibling.revision.id === s.revision.id) {
          sibling.revision = { ...updated };
          if (sibling !== s) this.persist(sibling);
        }
      }
    }
    if (pdfRole) s.pdf = { ...s.pdf, role: pdfRole };
    s.updatedAt = new Date().toISOString();
    this.persist(s);
    this._onDidChange.fire(s.adocPath);
  }

  /** Record a file this mapping produced, replacing any entry of the same kind. */
  recordArtifact(sidecarPath: string, artifact: Artifact): void {
    const s = this.getBySidecar(sidecarPath);
    if (!s) return;
    const rest = (s.artifacts ?? []).filter(
      (a) => !(a.kind === artifact.kind && samePath(a.path, artifact.path))
    );
    s.artifacts = [...rest, artifact];
    s.updatedAt = new Date().toISOString();
    this.persist(s);
    this._onDidChange.fire(s.adocPath);
  }

  /**
   * Forget a mapping and delete its sidecar. The manuscript, the PDF and any
   * exported report are left alone — only the mapping goes.
   */
  deleteMapping(sidecarPath: string): boolean {
    const s = this.getBySidecar(sidecarPath);
    if (!s) return false;
    try {
      if (fs.existsSync(s.sidecarPath)) fs.unlinkSync(s.sidecarPath);
    } catch (e) {
      vscode.window.showWarningMessage(
        `Eddie Doc: could not delete ${path.basename(s.sidecarPath)} — ${String(e)}`
      );
      return false;
    }
    this.sessions.delete(s.sidecarPath);
    if (this.activeByDoc.get(path.resolve(s.adocPath)) === s.sidecarPath) {
      this.activeByDoc.delete(path.resolve(s.adocPath));
    }
    this._onDidChange.fire(s.adocPath);
    return true;
  }

  /**
   * Where each loaded sidecar that still sits beside its manuscript would move
   * to under the review folder. Computed, never applied — see {@link migrate}.
   */
  planMigration(): MigrationStep[] {
    const steps: MigrationStep[] = [];
    for (const s of this.all()) {
      const folder = documentFolder(this.layout, s.adocPath);
      if (!folder) continue;
      const target = mappingSidecarPath(
        folder,
        s.revision.id,
        s.mapping.id
      );
      if (samePath(target, s.sidecarPath)) continue;
      steps.push({ from: s.sidecarPath, to: target, adocPath: s.adocPath });
    }
    return steps;
  }

  /**
   * Move sidecars into the review folder. Each file is rewritten at its new
   * location — paths inside are relative to the sidecar, so they must be
   * recomputed — and the old one removed only once the new one is on disk.
   */
  migrate(steps: MigrationStep[]): { moved: number; failed: string[] } {
    const failed: string[] = [];
    let moved = 0;
    for (const step of steps) {
      const s = this.getBySidecar(step.from);
      if (!s) continue;
      try {
        const previous = s.sidecarPath;
        s.sidecarPath = path.resolve(step.to);
        s.version = 3;
        ensureDir(path.dirname(s.sidecarPath));
        fs.writeFileSync(
          s.sidecarPath,
          serialize(s, s.sidecarPath),
          "utf8"
        );
        if (fs.existsSync(previous)) fs.unlinkSync(previous);
        this.sessions.delete(previous);
        this.sessions.set(s.sidecarPath, s);
        if (this.activeByDoc.get(path.resolve(s.adocPath)) === previous) {
          this.activeByDoc.set(path.resolve(s.adocPath), s.sidecarPath);
        }
        moved++;
      } catch (e) {
        failed.push(`${path.basename(step.from)}: ${String(e)}`);
      }
    }
    if (moved) this._onDidChange.fire(undefined);
    return { moved, failed };
  }

  // -- per-item state -------------------------------------------------------

  /**
   * Shift every annotation's line anchors through a batch of document edits so
   * positions stay live between saves. In-memory only (no persist / event) — the
   * caller drives UI updates; the save-time remap persists the reconciled state.
   * Returns true if anything moved.
   */
  shiftPositions(adocPath: string, changes: ContentChange[]): boolean {
    if (changes.length === 0) return false;
    let moved = false;
    // Every round of this document points into the same text, so an edit moves
    // all of them — not just the one on screen.
    for (const it of this.sessionsFor(adocPath).flatMap((s) => s.items)) {
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
    return this.get(adocPath)?.items.find((i) => i.id === id);
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
    const session = this.get(adocPath);
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
    const s = this.get(adocPath);
    if (!s) return;
    s.updatedAt = new Date().toISOString();
    this.persist(s);
    this._onDidChange.fire(adocPath);
  }

  private persist(session: ReviewSession): void {
    try {
      // Any write upgrades the sidecar to the current on-disk standard.
      session.version = 3;
      ensureDir(path.dirname(session.sidecarPath));
      fs.writeFileSync(
        session.sidecarPath,
        serialize(session, session.sidecarPath),
        "utf8"
      );
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

/** Drop keys whose value is undefined so a spread cannot erase a set field. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
