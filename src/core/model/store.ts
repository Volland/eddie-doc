import * as path from "../util/path.js";
import { randomHex } from "../util/random.js";
import { sha256Text } from "../util/sha256.js";
import { decodeUtf8 } from "../util/text.js";
import { Emitter, type HostServices } from "../host/services.js";
import type { Progress } from "../host/progress.js";
import {
  mappingLabel,
  markSourceName,
  type Artifact,
  type MappingInfo,
  type PdfInfo,
  type PdfRole,
  type PdfSource,
  type RawAnnotation,
  type Reply,
  type ReviewItem,
  type ReviewSession,
  type RevisionInfo,
  type SessionIntegrity,
} from "./types.js";
import {
  appendItems,
  mergeInto,
  nextPdfId,
  sameRemarkKey,
  type MergeOutcome,
} from "./combine.js";
import { assignNumbers } from "./numbering.js";
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
  bySourcePosition,
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
  return "r-" + randomHex(4);
}

/** The form a path takes as a map key, so `a/./b` and `a/b` are one file. */
function key(p: string): string {
  return path.normalize(p);
}

/** Compare two paths as the storage would address them. */
function samePath(a: string, b: string): boolean {
  return key(a) === key(b);
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
  /** Per-page progress and cancellation for the extraction. */
  progress?: Progress;
}

/** Adding one more PDF's marks to an existing mapping. */
export interface AppendPdfOptions {
  threshold: number;
  /** Where these marks came from, when it is not the mapping's own origin. */
  origin?: string;
  /** Who made these marks, when the PDF does not name them. */
  reviewer?: string;
  /** What kind of PDF is being added. Defaults to `annotated`. */
  pdfRole?: PdfRole;
  /** Copy the PDF into the revision's `pdf/` folder and read the copy. */
  importPdf?: boolean;
  /** Per-page progress and cancellation for the extraction. */
  progress?: Progress;
}

/** What {@link ReviewStore.appendPdf} did. */
export interface AppendPdfResult {
  /** Marks new to the mapping. */
  added: ReviewItem[];
  /** Marks skipped because the mapping already had them. */
  duplicates: number;
  /** The PDF's record in the mapping; undefined when it was already there. */
  source?: PdfSource;
  /** The byte-identical PDF is already part of the mapping; nothing was read. */
  alreadyPresent?: boolean;
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
  /** Every loaded mapping, keyed by the normalized path of its sidecar. */
  private sessions = new Map<string, ReviewSession>();
  /** The mapping each document is currently showing: adocPath -> sidecarPath. */
  private activeByDoc = new Map<string, string>();
  private readonly _onDidChange = new Emitter<string | undefined>();
  /** Fires with the affected adocPath, or undefined for a broad refresh. */
  readonly onDidChange = this._onDidChange.event;
  /** Only nag once per session if the semantic backend is unreachable. */
  private semanticWarned = false;
  /** Embedding memo shared across maps; upgraded to a file cache on activate. */
  private embedCache: EmbedCache = new MemoryEmbedCache();
  /** Where review artifacts live. Set on activation, and on settings changes. */
  private layout: LayoutConfig = { reviewFolder: "" };
  /** Sessions whose latest state has not reached the storage yet. */
  private readonly pending = new Set<ReviewSession>();
  /** The running drain of {@link pending}, or null when idle. */
  private writer: Promise<void> | null = null;
  /**
   * Hash of each sidecar's text as this store last read or wrote it. A file whose
   * hash differs was changed by someone else — another device, a sync client, a
   * text editor — and an echo of our own write is recognised by matching it.
   */
  private readonly stamps = new Map<string, string>();

  constructor(private readonly host: HostServices) {}

  /** Persist embeddings under `file` so re-maps across restarts skip Ollama. */
  useEmbedCacheFile(file: string): void {
    this.embedCache = new FileEmbedCache(this.host.storage, file);
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
    const doc = key(adocPath);
    const active = this.activeByDoc.get(doc);
    if (active) {
      const s = this.sessions.get(active);
      if (s) return s;
      this.activeByDoc.delete(doc);
    }
    // No explicit choice (or it went away): fall back to the newest mapping.
    const all = this.sessionsFor(adocPath);
    const pick = all[all.length - 1];
    if (pick) this.activeByDoc.set(doc, pick.sidecarPath);
    return pick;
  }

  getBySidecar(sidecarPath: string): ReviewSession | undefined {
    return this.sessions.get(key(sidecarPath));
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
    this.activeByDoc.set(key(s.adocPath), key(sidecarPath));
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
  async tryLoadSidecar(adocPath: string): Promise<ReviewSession | undefined> {
    let loaded = false;
    const legacy = legacySidecarPath(adocPath);
    if (
      !this.sessions.has(key(legacy)) &&
      (await this.host.storage.exists(legacy))
    ) {
      loaded = !!(await this.loadSidecarFile(legacy, adocPath)) || loaded;
    }
    for (const file of await this.discoverSidecars(adocPath)) {
      if (this.sessions.has(key(file))) continue;
      loaded = !!(await this.loadSidecarFile(file, adocPath)) || loaded;
    }
    if (loaded) this._onDidChange.fire(adocPath);
    return this.get(adocPath);
  }

  /** Sidecar files under a document's folder in the review tree. */
  private async discoverSidecars(adocPath: string): Promise<string[]> {
    const folder = documentFolder(this.layout, adocPath);
    if (!folder) return [];
    const out: string[] = [];
    for (const rev of await this.host.storage.list(folder)) {
      if (!rev.isDirectory) continue;
      const revDir = path.join(folder, rev.name);
      for (const f of await this.host.storage.list(revDir)) {
        if (!f.isDirectory && /\.review\.json$/i.test(f.name)) {
          out.push(path.join(revDir, f.name));
        }
      }
    }
    return out.sort();
  }

  /**
   * Read one sidecar into the store. `adocPath` binds it to a known source; when
   * omitted the file's own recorded source path is used, which is how discovery
   * finds the manuscript for a sidecar living under the review folder.
   */
  async loadSidecarFile(
    sidecarPath: string,
    adocPath?: string
  ): Promise<ReviewSession | undefined> {
    try {
      const text = await this.host.storage.readText(sidecarPath);
      const bound = adocPath ?? resolveSourcePath(text, sidecarPath);
      if (!bound || !(await this.host.storage.exists(bound))) return undefined;
      const session = parse(text, sidecarPath, bound);
      if (!session) return undefined;
      session.sidecarPath = key(sidecarPath);
      this.stamps.set(session.sidecarPath, sha256Text(text));
      // A sidecar from before numbering is numbered on sight, in reading
      // order, so the same file shows the same numbers until it is next saved.
      this.number(session);
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
      const copied = await this.importPdf(adocPath, revision, mappingId, pdfPath);
      if (copied) {
        mappedPdf = copied;
        pdfInfo.imported = true;
        pdfInfo.importedFrom = pdfPath;
      }
    }

    const bytes = await this.host.storage.readBytes(mappedPdf);
    const sourceBytes = await this.host.storage.readBytes(adocPath);
    const source = decodeUtf8(sourceBytes);
    // Fingerprint BEFORE extraction. pdfjs used to detach this array (see
    // extract.ts), which turned the digest into the sha-256 of zero bytes and
    // silently disabled staleness detection. Hashing first makes that ordering
    // bug unrepresentable regardless of what the extractor does with the array.
    const pdfSha256 = sha256(bytes);
    const annots = await extractAnnotations(bytes, opts.progress);
    // Re-binding replaces the mapping's own PDF only. Marks from PDFs added to
    // it later are kept, and must not lend their state to look-alike marks in
    // the new file — so they are left out of the carry and re-mapped apart.
    const prev = existing
      ? existing.items.filter((i) => !i.pdfId)
      : this.carrySource(adocPath, revision, opts.mapping?.origin)?.items;
    const stats: MapStats = { carried: 0 };
    let items = mapAnnotations(
      annots,
      source,
      { threshold: opts.threshold },
      prev,
      stats
    );
    if (!existing) {
      // A new round is a new list: its numbers start again at 1, rather than
      // inheriting the previous round's by content.
      for (const it of items) it.number = it.initials = undefined;
    } else {
      // Ids re-key when a PDF is re-exported, and the mapper only rescues items
      // the author touched. The rest are still the same remarks, and keep
      // their numbers by content.
      const byKey = new Map<string, ReviewItem[]>();
      const taken = new Set(items.map((i) => i.number).filter((n) => n != null));
      for (const p of prev ?? []) {
        if (p.number == null || taken.has(p.number)) continue;
        const k = sameRemarkKey(p);
        byKey.set(k, [...(byKey.get(k) ?? []), p]);
      }
      for (const it of items) {
        if (it.number != null) continue;
        const twin = byKey.get(sameRemarkKey(it))?.shift();
        if (twin) {
          it.number = twin.number;
          it.initials = twin.initials;
        }
      }
      const added = existing.items.filter((i) => i.pdfId);
      if (added.length) {
        const kept = mapAnnotations(
          added.map(toRaw),
          source,
          { threshold: opts.threshold },
          added
        );
        items = [...items, ...kept].sort(bySourcePosition);
      }
    }
    await this.runFallbacks(items, source);
    // Carrying state into a new round can surface marks whose paragraph is gone.
    this.warnNewlyStale(stats.stale ?? 0);
    if (stats.carried > 0) {
      // A re-exported PDF re-keys every annotation id; content fingerprints
      // just rescued that state, and the user should know it survived.
      this.host.notify.info(
        `Eddie Doc: carried review state for ${stats.carried} annotation(s) ` +
          `from the previous round.`
      );
    }

    const now = new Date().toISOString();
    const session: ReviewSession = {
      version: 3,
      sidecarPath: key(sidecar),
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
        sourceSha256: sha256(sourceBytes),
        sourceBytes: sourceBytes.length,
        pdfSha256,
        pdfAnnotationCount: annots.length,
      },
      artifacts: existing?.artifacts,
      extraPdfs: existing?.extraPdfs,
      items,
    };
    this.sessions.set(session.sidecarPath, session);
    this.activeByDoc.set(key(adocPath), session.sidecarPath);
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
  private async importPdf(
    adocPath: string,
    revision: RevisionInfo,
    mappingId: string,
    pdfPath: string
  ): Promise<string | undefined> {
    const folder = documentFolder(this.layout, adocPath);
    if (!folder) return undefined;
    const dir = pdfFolder(folder, revision.id);
    const target = path.join(dir, `${mappingId}.pdf`);
    try {
      if (samePath(target, pdfPath)) return target;
      await this.host.storage.copy(pdfPath, target);
      return target;
    } catch (e) {
      this.host.notify.warn(
        `Eddie Doc: could not import the PDF into the review folder — ${String(e)}`
      );
      return undefined;
    }
  }

  /**
   * Add another PDF's marks to an existing mapping.
   *
   * This is how a review is *continued*: the editor sends the chapter again
   * with more marks, or a second editor's copy of the same pass arrives. The
   * new marks join the mapping the author is already working through, take the
   * next numbers, and everything already there — numbers, resolutions, replies
   * — stays exactly as it was. Marks the mapping already holds are skipped, so
   * a re-sent copy only contributes what is new on it.
   */
  async appendPdf(
    sidecarPath: string,
    pdfPath: string,
    opts: AppendPdfOptions
  ): Promise<AppendPdfResult> {
    const session = this.getBySidecar(sidecarPath);
    if (!session) throw new Error("that mapping is not loaded");

    const original = await this.host.storage.readBytes(pdfPath);
    const sha = sha256(original);
    const known = [
      session.integrity?.pdfSha256,
      ...(session.extraPdfs ?? []).map((p) => p.sha256),
    ];
    if (known.includes(sha)) {
      return { added: [], duplicates: 0, alreadyPresent: true };
    }

    const pdfId = nextPdfId(session);
    const source: PdfSource = {
      id: pdfId,
      path: pdfPath,
      role: opts.pdfRole ?? "annotated",
      sha256: sha,
      addedAt: new Date().toISOString(),
      origin: opts.origin || undefined,
      reviewer: opts.reviewer || undefined,
    };
    if (opts.importPdf) {
      const copied = await this.importPdf(
        session.adocPath,
        session.revision,
        `${session.mapping.id}-${pdfId}`,
        pdfPath
      );
      if (copied) {
        source.path = copied;
        source.imported = true;
        source.importedFrom = pdfPath;
      }
    }

    const sourceText = await this.host.storage.readText(session.adocPath);
    const annots = await extractAnnotations(original, opts.progress);
    source.annotationCount = annots.length;
    // Tag each mark with its PDF before mapping, so the fallbacks and the
    // duplicate check see the item exactly as it will be stored.
    const fresh = mapAnnotations(annots, sourceText, {
      threshold: opts.threshold,
    }).map((it) => ({ ...it, pdfId }));
    await this.runFallbacks(fresh, sourceText);

    const outcome = appendItems(session, source, fresh, (it) =>
      markSourceName(session, it)
    );
    session.updatedAt = new Date().toISOString();
    this.persist(session);
    this._onDidChange.fire(session.adocPath);
    return { ...outcome, source };
  }

  /**
   * Fold other mappings of the same document into `targetSidecar`, then delete
   * their sidecars. Their PDFs, items and review state all move to the target —
   * see {@link mergeInto} for what happens to numbers and repeated marks.
   *
   * The target is written before anything is deleted, so a failure part-way
   * leaves at worst a remark in two mappings, never a remark in none.
   */
  async mergeMappings(
    targetSidecar: string,
    otherSidecars: string[]
  ): Promise<MergeOutcome & { removed: string[]; failed: string[] }> {
    const target = this.getBySidecar(targetSidecar);
    if (!target) throw new Error("the mapping to merge into is not loaded");
    const others = otherSidecars
      .map((p) => this.getBySidecar(p))
      .filter((s): s is ReviewSession => !!s && s !== target);
    for (const o of others) {
      if (!samePath(o.adocPath, target.adocPath)) {
        throw new Error(
          `${mappingLabel(o)} reviews a different document; only mappings ` +
            `of the same source can be merged`
        );
      }
    }

    const outcome = mergeInto(target, others);
    target.updatedAt = new Date().toISOString();
    this.persist(target);
    // The target must be on disk before anything is deleted — see above.
    await this.flush();

    const removed: string[] = [];
    const failed: string[] = [];
    for (const o of others) {
      try {
        await this.host.storage.remove(o.sidecarPath);
        this.sessions.delete(o.sidecarPath);
        this.stamps.delete(o.sidecarPath);
        this.pending.delete(o);
        removed.push(o.sidecarPath);
      } catch (e) {
        failed.push(`${path.basename(o.sidecarPath)}: ${String(e)}`);
      }
    }
    this.activeByDoc.set(key(target.adocPath), target.sidecarPath);
    this._onDidChange.fire(target.adocPath);
    return { ...outcome, removed, failed };
  }

  /**
   * Re-run matching against the current source text (e.g. after edits) for the
   * document's active mapping. Reuses the annotations already extracted from the
   * PDF — no re-read of the PDF, so it's cheap and works even if the PDF moved.
   */
  async remap(adocPath: string, threshold: number): Promise<void> {
    const session = this.get(adocPath);
    if (!session) return;
    const res = await this.remapSession(session, threshold, false);
    this.warnNewlyStale(res.newlyStale);
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
    let newlyStale = 0;
    for (const s of this.sessionsFor(adocPath)) {
      const res = await this.remapSession(
        s,
        threshold,
        opts.onlyIfSourceChanged ?? false
      );
      if (res.changed) remapped++;
      newlyStale += res.newlyStale;
    }
    this.warnNewlyStale(newlyStale);
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
  ): Promise<{ changed: boolean; newlyStale: number }> {
    const sourceBytes = await this.host.storage.readBytes(session.adocPath);
    const sha = sha256(sourceBytes);
    if (skipUnchangedSource && session.integrity?.sourceSha256 === sha) {
      return { changed: false, newlyStale: 0 };
    }
    const source = decodeUtf8(sourceBytes);
    const raw = session.items.map(toRaw);
    const wasStale = session.items.filter((i) => i.stale).length;
    const items = mapAnnotations(raw, source, { threshold }, session.items);
    await this.runFallbacks(items, source);
    const newlyStale = Math.max(
      0,
      items.filter((i) => i.stale).length - wasStale
    );
    session.items = items;
    session.version = 3;
    session.updatedAt = new Date().toISOString();
    session.integrity = {
      ...session.integrity,
      sourceSha256: sha,
      sourceBytes: sourceBytes.length,
    } satisfies SessionIntegrity;
    this.persist(session);
    return { changed: true, newlyStale };
  }

  /**
   * Say it once when marks stop describing their text. Only the *newly* stale
   * are worth a message: an already-flagged item is on the tree waiting for the
   * author, and repeating it on every save would train them to dismiss it.
   */
  private warnNewlyStale(count: number): void {
    if (count <= 0) return;
    this.host.notify.warn(
      `Eddie Doc: ${count} annotation(s) no longer match the text they were ` +
        `linked to. They are held at their last known place and marked stale ` +
        `under "Needs review" — confirm or re-link them.`
    );
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
    const cfg = this.host.settings();
    // No localhost to reach on some hosts (mobile): the setting is moot there.
    if (cfg.semanticFallback && this.host.capabilities.semanticFallback) {
      const url = cfg.ollamaUrl;
      const model = cfg.embedModel;
      if (this.embedCache instanceof FileEmbedCache) {
        await this.embedCache.load();
      }
      const res = await semanticFallback(items, source, {
        url,
        model,
        threshold: cfg.semanticThreshold,
        cache: this.embedCache,
        fetchFn: this.host.fetch,
      });
      if (!res.ok && !this.semanticWarned) {
        this.semanticWarned = true;
        this.host.notify.warn(
          `Eddie Doc: semantic fallback couldn't reach Ollama at ${url}. ` +
            `Start Ollama (with the '${model}' model pulled) or turn off the semantic fallback setting.`
        );
      }
    }
    if (cfg.lexicalFallback) {
      lexicalFallback(items, source, cfg.lexicalThreshold);
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
  async deleteMapping(sidecarPath: string): Promise<boolean> {
    const s = this.getBySidecar(sidecarPath);
    if (!s) return false;
    // Drop it from the write queue first, or a pending save would recreate it.
    this.pending.delete(s);
    try {
      await this.host.storage.remove(s.sidecarPath);
    } catch (e) {
      this.host.notify.warn(
        `Eddie Doc: could not delete ${path.basename(s.sidecarPath)} — ${String(e)}`
      );
      return false;
    }
    this.sessions.delete(s.sidecarPath);
    this.stamps.delete(s.sidecarPath);
    if (this.activeByDoc.get(key(s.adocPath)) === s.sidecarPath) {
      this.activeByDoc.delete(key(s.adocPath));
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
  async migrate(
    steps: MigrationStep[]
  ): Promise<{ moved: number; failed: string[] }> {
    const failed: string[] = [];
    let moved = 0;
    await this.flush();
    for (const step of steps) {
      const s = this.getBySidecar(step.from);
      if (!s) continue;
      const previous = s.sidecarPath;
      try {
        s.sidecarPath = key(step.to);
        s.version = 3;
        const text = serialize(s, s.sidecarPath);
        await this.host.storage.writeText(s.sidecarPath, text);
        this.stamps.set(s.sidecarPath, sha256Text(text));
        this.stamps.delete(previous);
        await this.host.storage.remove(previous);
        this.sessions.delete(previous);
        this.sessions.set(s.sidecarPath, s);
        if (this.activeByDoc.get(key(s.adocPath)) === previous) {
          this.activeByDoc.set(key(s.adocPath), s.sidecarPath);
        }
        moved++;
      } catch (e) {
        s.sidecarPath = previous; // the move did not happen; keep addressing the old file
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
    item.stale = undefined; // and it answers whatever the flag was asking
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
    item.stale = undefined; // vouching for the link is how a stale one is settled
    this.touch(adocPath);
  }

  /**
   * Re-run automatic matching for a single annotation against the current source
   * text, dropping any manual override. Returns the resulting effective match
   * (null when nothing clears the threshold).
   */
  async remapItem(
    adocPath: string,
    id: string,
    threshold: number
  ): Promise<void> {
    const item = this.findItem(adocPath, id);
    if (!item) return;
    const source = await this.host.storage.readText(adocPath);
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
      item.stale = undefined;
      this.touch(adocPath);
      return;
    }
    const idx = buildSourceIndex(source);
    const fresh = matchOne(item, idx, threshold);
    // Asked for explicitly, so it is allowed to move the mark — but a search
    // that found nothing must not blank a position the author can still use.
    item.stale = fresh ? undefined : true;
    if (fresh) item.match = fresh;
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

  /** Number whatever is unnumbered and fill in missing initials. */
  private number(session: ReviewSession): boolean {
    return assignNumbers(session.items, (it) => markSourceName(session, it));
  }

// @lat: [[architecture#Persistence]]
  /**
   * Queue a session for saving. The in-memory change is already made, so the
   * caller (a click, a keystroke) never waits on storage; writes are coalesced —
   * a burst of edits to one mapping becomes one file write — and serialized.
   * `await flush()` when the file must be on disk before moving on.
   */
  private persist(session: ReviewSession): void {
    // Every written sidecar is fully numbered — including one whose reviewer
    // was only just named, which is when unattributed marks get initials.
    this.number(session);
    // Any write upgrades the sidecar to the current on-disk standard.
    session.version = 3;
    this.pending.add(session);
    this.writer ??= this.drain();
  }

  private async drain(): Promise<void> {
    // Let the rest of this tick's mutations land, so they share one write.
    await Promise.resolve();
    try {
      while (this.pending.size) {
        const session = this.pending.values().next().value as ReviewSession;
        this.pending.delete(session);
        // Forgotten or replaced since it was queued: writing would resurrect it.
        if (this.sessions.get(session.sidecarPath) !== session) continue;
        try {
          await this.writeSidecar(session);
        } catch (e) {
          this.host.notify.warn(
            `Eddie Doc: could not save review sidecar: ${String(e)}`
          );
        }
      }
    } finally {
      this.writer = null;
    }
  }

  /**
   * Write one sidecar, first checking that nobody else changed the file since this
   * store last read or wrote it. If they did, their work is folded in (see
   * {@link mergeRemote}) and a copy of their version is kept beside the file, so
   * a write never silently discards another device's replies.
   */
  private async writeSidecar(session: ReviewSession): Promise<void> {
    const p = session.sidecarPath;
    const known = this.stamps.get(p);
    if (known !== undefined) {
      let disk: string | undefined;
      try {
        disk = (await this.host.storage.exists(p)) ? await this.host.storage.readText(p) : undefined;
      } catch {
        disk = undefined;
      }
      if (disk !== undefined && sha256Text(disk) !== known) {
        await this.resolveConflict(session, disk);
      }
    }
    // Numbering may have changed while merging.
    this.number(session);
    const text = serialize(session, p);
    await this.host.storage.writeText(p, text);
    this.stamps.set(p, sha256Text(text));
  }

  private async resolveConflict(session: ReviewSession, diskText: string): Promise<void> {
    const p = session.sidecarPath;
    const remote = parse(diskText, p, session.adocPath);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const copy = p.replace(/\.review\.json$/i, "") + `.conflict-${stamp}.txt`;
    try {
      await this.host.storage.writeText(copy, diskText);
    } catch {
      /* the backup is a courtesy; the merge below is what protects the work */
    }
    if (remote) mergeRemote(session, remote);
    this.host.notify.warn(
      `Eddie Doc: ${path.basename(p)} was changed elsewhere while you were editing it. ` +
        `Replies and new annotations from the other copy were merged in; ` +
        `the other copy is kept as ${path.basename(copy)}.`
    );
  }

  /**
   * Another device, a sync client or an editor changed a sidecar. Re-read it —
   * unless it is just the echo of our own write, or we have unsaved changes of
   * our own, which are reconciled when they are written.
   */
  async reloadFromDisk(
    sidecarPath: string
  ): Promise<"reloaded" | "unchanged" | "pending" | "missing"> {
    const p = key(sidecarPath);
    const session = this.sessions.get(p);
    // Checked before any await: a queued save can finish while we wait on the
    // storage, and unsaved work is reconciled by that write, not by a reload.
    if (session && this.pending.has(session)) return "pending";
    if (!(await this.host.storage.exists(p))) {
      if (!session) return "unchanged";
      this.dropSession(p);
      return "missing";
    }
    let text: string;
    try {
      text = await this.host.storage.readText(p);
    } catch {
      return "unchanged";
    }
    if (sha256Text(text) === this.stamps.get(p)) return "unchanged"; // our own echo
    if (!session) {
      return (await this.loadSidecarFile(p)) ? (this._onDidChange.fire(undefined), "reloaded") : "unchanged";
    }
    if (this.pending.has(session)) return "pending"; // queued while we were reading
    const fresh = parse(text, p, session.adocPath);
    if (!fresh) return "unchanged"; // unreadable: keep what we have
    fresh.sidecarPath = p;
    this.number(fresh);
    this.sessions.set(p, fresh);
    this.stamps.set(p, sha256Text(text));
    this._onDidChange.fire(fresh.adocPath);
    return "reloaded";
  }

  /** Forget a mapping whose file is gone, without touching any file. */
  dropSession(sidecarPath: string): void {
    const p = key(sidecarPath);
    const s = this.sessions.get(p);
    if (!s) return;
    this.pending.delete(s);
    this.sessions.delete(p);
    this.stamps.delete(p);
    if (this.activeByDoc.get(key(s.adocPath)) === p) this.activeByDoc.delete(key(s.adocPath));
    this._onDidChange.fire(s.adocPath);
  }

  /**
   * A file or folder was renamed: follow it. Re-keys the affected sessions and
   * rewrites each sidecar, whose recorded paths are relative to itself, so
   * renaming a manuscript, a PDF or the review folder does not orphan a review.
   * Returns how many mappings changed.
   */
  rebindPaths(oldPath: string, newPath: string): number {
    const from = key(oldPath);
    const to = key(newPath);
    const move = (p: string | undefined): string | undefined => {
      if (!p) return p;
      const k = key(p);
      if (k === from) return to;
      return k.startsWith(from + "/") ? to + k.slice(from.length) : p;
    };
    let changed = 0;
    for (const s of [...this.sessions.values()]) {
      const before = JSON.stringify([s.sidecarPath, s.adocPath, s.pdfPath, s.pdf?.importedFrom, s.extraPdfs?.map((x) => x.path), s.artifacts?.map((a) => a.path)]);
      const oldSidecar = s.sidecarPath;
      const oldAdoc = key(s.adocPath);
      s.adocPath = move(s.adocPath) ?? s.adocPath;
      s.pdfPath = move(s.pdfPath) ?? s.pdfPath;
      if (s.pdf?.importedFrom) s.pdf = { ...s.pdf, importedFrom: move(s.pdf.importedFrom) };
      if (s.extraPdfs) s.extraPdfs = s.extraPdfs.map((x) => ({ ...x, path: move(x.path) ?? x.path, importedFrom: move(x.importedFrom) }));
      if (s.artifacts) s.artifacts = s.artifacts.map((a) => ({ ...a, path: move(a.path) ?? a.path }));
      const newSidecar = key(move(oldSidecar) ?? oldSidecar);
      s.sidecarPath = newSidecar;
      const after = JSON.stringify([s.sidecarPath, s.adocPath, s.pdfPath, s.pdf?.importedFrom, s.extraPdfs?.map((x) => x.path), s.artifacts?.map((a) => a.path)]);
      if (before === after) continue;
      changed++;
      if (newSidecar !== oldSidecar) {
        this.sessions.delete(oldSidecar);
        this.sessions.set(newSidecar, s);
        const stamp = this.stamps.get(oldSidecar);
        this.stamps.delete(oldSidecar);
        // The file moved with its contents: what we last saw is what is there.
        if (stamp !== undefined) this.stamps.set(newSidecar, stamp);
      }
      const newAdoc = key(s.adocPath);
      if (newAdoc !== oldAdoc || newSidecar !== oldSidecar) {
        const active = this.activeByDoc.get(oldAdoc);
        if (active !== undefined) {
          this.activeByDoc.delete(oldAdoc);
          this.activeByDoc.set(newAdoc, active === oldSidecar ? newSidecar : active);
        }
      }
      s.updatedAt = new Date().toISOString();
      this.persist(s);
    }
    if (changed) this._onDidChange.fire(undefined);
    return changed;
  }

  /** Resolves once every queued save has reached the storage. */
  async flush(): Promise<void> {
    while (this.writer) await this.writer;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Fold another copy of the same mapping into `local`: replies it has that we lack
 * are added (oldest first), and annotations only it holds — another device
 * appended a PDF, say — are added. Everything else stays as `local` has it; we
 * cannot tell which side changed a resolved flag, and local is what the author
 * is looking at.
 */
function mergeRemote(local: ReviewSession, remote: ReviewSession): void {
  const byId = new Map(local.items.map((i) => [i.id, i]));
  let added = false;
  for (const r of remote.items) {
    const l = byId.get(r.id);
    if (!l) {
      local.items.push(r);
      added = true;
      continue;
    }
    const have = new Set((l.replies ?? []).map((x) => x.id));
    const extra = (r.replies ?? []).filter((x) => !have.has(x.id));
    if (extra.length) {
      l.replies = [...(l.replies ?? []), ...extra].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
    }
  }
  if (added) local.items.sort(bySourcePosition);
  const knownPdfs = new Set((local.extraPdfs ?? []).map((p) => p.id));
  const morePdfs = (remote.extraPdfs ?? []).filter((p) => !knownPdfs.has(p.id));
  if (morePdfs.length) local.extraPdfs = [...(local.extraPdfs ?? []), ...morePdfs];
}

/** Drop keys whose value is undefined so a spread cannot erase a set field. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
