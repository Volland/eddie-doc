/**
 * The Eddie Doc Review Format — the portable, versioned on-disk standard that
 * backs the `<file>.review.json` sidecar.
 *
 * This module is the single source of truth for how a {@link ReviewSession} is
 * serialized to and parsed from disk. The on-disk shape is deliberately NOT the
 * in-memory domain model: it is nested (annotation / match / state), uses paths
 * relative to the sidecar so the file is portable across machines and check-ins,
 * and carries content fingerprints so a consumer can detect stale inputs.
 *
 * One file describes one **mapping**: a single annotated PDF matched onto a
 * single source. A document accumulates many of them — several per round when
 * the marks came back from several editors, and a fresh set for each round — so
 * every file also records which round and which mapping it is.
 *
 * See `docs/FORMAT.md` for the human-readable spec and
 * `schema/review-v3.schema.json` for the JSON Schema.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  AnnotationKind,
  ArtifactKind,
  Match,
  MappingInfo,
  MappingKind,
  MatchMethod,
  PdfInfo,
  PdfRole,
  Reply,
  ReviewItem,
  ReviewSession,
  ReviewType,
  RevisionInfo,
  SessionIntegrity,
  SourceAnchor,
} from "./types.js";

/** Canonical identifier of the current format; also the `$schema` value. */
export const SCHEMA_URL =
  "https://volland.github.io/eddie-doc/schema/review-v3.schema.json";

/** On-disk format version this build reads and writes. */
export const FORMAT_VERSION = 3 as const;

/**
 * Producer stamp written into every sidecar. The version literal is rewritten
 * from package.json by `scripts/sync-producer.mjs`, which runs as npm's
 * "version" lifecycle hook during a release bump — do not edit it by hand.
 */
export const PRODUCER = { name: "eddie-doc", version: "1.1.7" } as const;

// ---------------------------------------------------------------------------
// On-disk document shape (version 3)
// ---------------------------------------------------------------------------

/** A referenced input file, addressed relative to the sidecar. */
export interface FileRefDoc {
  /** Path relative to the sidecar's directory, POSIX separators. */
  path: string;
  /** SHA-256 (hex) of the file's bytes at map time, if known. */
  sha256?: string;
  /** Size in bytes at map time, if known. */
  bytes?: number;
}

/**
 * The PDF input: a file reference, an annotation count for quick staleness
 * checks, and — since v3 — what kind of PDF it is, so a consumer can tell an
 * editor's marked-up copy from a clean render of the same chapter.
 */
export interface PdfRefDoc extends FileRefDoc {
  annotationCount?: number;
  /** What kind of PDF this is. Absent in v1/v2 files, which are all annotated. */
  role?: PdfRole;
  /** True when the PDF was copied in beside the sidecar. */
  imported?: boolean;
  /** Original location of an imported PDF, relative to the sidecar when possible. */
  importedFrom?: string;
}

/** The editing round this mapping belongs to. */
export interface RevisionDoc {
  id: string;
  ordinal: number;
  label?: string;
  receivedAt?: string;
  note?: string;
}

/** What this mapping is, and who produced the marks behind it. */
export interface MappingDoc {
  id: string;
  kind: MappingKind;
  label?: string;
  origin?: string;
  reviewer?: string;
  reviewType?: ReviewType;
  createdAt?: string;
}

/** A file produced from this mapping, addressed relative to the sidecar. */
export interface ArtifactDoc {
  kind: ArtifactKind;
  path: string;
  createdAt?: string;
  note?: string;
}

/** Where an annotation physically sits in the PDF. */
export interface GeometryDoc {
  /** 1-based page number. */
  page: number;
  /** Coordinate unit. Always PDF points for now. */
  unit: "pt";
  /** Origin corner of the coordinate system. PDF user space is bottom-left. */
  origin: "bottom-left";
  /** Bounding box [x0, y0, x1, y1] in `unit`, `origin` coordinates. */
  rect: [number, number, number, number];
  /**
   * Optional per-line quad points [x1,y1,...] (8 numbers per quad) for markup
   * spanning multiple lines. Reserved; not yet populated by the extractor.
   */
  quadPoints?: number[];
}

/** The immutable, PDF-derived part of a review item. */
export interface AnnotationDoc {
  kind: AnnotationKind;
  author?: string;
  /** The editor's comment body, if any. */
  comment?: string;
  /** Text physically under the markup (over-captures a line for matching). */
  anchoredText?: string;
  /** Tightly-bounded text inside the markup quads (for character-level edits). */
  markedText?: string;
  /** For caret/insert marks: text left of the caret on the same line. */
  beforeText?: string;
  geometry: GeometryDoc;
}

/** The recomputable mapping of an annotation onto the source. Cache, not truth. */
export interface MatchDoc {
  /** 0-based start line in the source document. */
  startLine: number;
  /** 0-based end line (inclusive). */
  endLine: number;
  /** 0–1 similarity of the matched span. */
  score: number;
  /** How the match was produced. */
  method?: MatchMethod;
  /** Non-authoritative snapshot of the matched source text, for display only. */
  sourceExcerpt?: string;
}

/** The user-owned review state — the only part a human edits over time. */
export interface StateDoc {
  resolved: boolean;
  /** User has vouched for the link (hand-picked or accepted a weak match). */
  confirmed?: boolean;
  /** The text this link described has changed; held in place pending a human. */
  stale?: boolean;
  /** 0-based line the user manually linked to; overrides `match`. */
  manualLine?: number;
  note?: string;
  /** The author's reply thread, oldest first. */
  replies?: Reply[];
}

/**
 * One review item on disk, in four blocks that evolve and diff independently:
 * what the PDF said (`annotation`, immutable), where the text lives
 * (`anchor`, durable), what the matcher computed (`match`, a cache), and what
 * the human decided (`state`).
 */
export interface ItemDoc {
  /** Stable id, ideally the PDF annotation id; falls back to page+geometry. */
  id: string;
  annotation: AnnotationDoc;
  /** Durable source binding — survives edits the matcher cannot follow. */
  anchor?: SourceAnchor;
  match: MatchDoc | null;
  state: StateDoc;
}

/**
 * Root of a version-3 sidecar document.
 *
 * v3 adds the round-trip metadata v2 had nowhere to put: which editing round
 * this file belongs to (`revision`), which of that round's mappings it is
 * (`mapping`), what kind of PDF was mapped (`pdf.role`) and what else the
 * mapping produced (`artifacts`). Everything below `items` is unchanged from v2.
 */
export interface ReviewDocumentV3 {
  $schema?: string;
  version: 3;
  producer?: { name: string; version?: string };
  createdAt: string;
  updatedAt: string;
  revision: RevisionDoc;
  mapping: MappingDoc;
  source: FileRefDoc;
  pdf: PdfRefDoc;
  artifacts?: ArtifactDoc[];
  items: ItemDoc[];
}

// ---------------------------------------------------------------------------
// Legacy version-2 document (one sidecar per .adoc, no rounds)
// ---------------------------------------------------------------------------

/** Root of a version-2 sidecar document. */
export interface ReviewDocumentV2 {
  $schema?: string;
  version: 2;
  producer?: { name: string; version?: string };
  createdAt: string;
  updatedAt: string;
  source: FileRefDoc;
  pdf: PdfRefDoc;
  items: ItemDoc[];
}

// ---------------------------------------------------------------------------
// Legacy version-1 document (flat; == the old in-memory shape)
// ---------------------------------------------------------------------------

interface ReviewDocumentV1 {
  version: 1;
  adocPath: string;
  pdfPath: string;
  createdAt: string;
  updatedAt: string;
  items: Array<
    {
      id: string;
      kind: AnnotationKind;
      page: number;
      comment?: string;
      anchoredText?: string;
      markedText?: string;
      beforeText?: string;
      author?: string;
      rect: [number, number, number, number];
      match?: Match | null;
      resolved?: boolean;
      manualLine?: number;
      confirmed?: boolean;
      note?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a byte buffer. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of zero bytes. */
export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * A recorded fingerprint, or undefined when it carries no information.
 *
 * A stored digest equal to {@link EMPTY_SHA256} never means "this file is
 * empty" — it means the hash was taken over a buffer that had already been
 * emptied. pdfjs transfers (and thereby detaches) the array it is handed, so
 * sidecars written before that was fixed recorded the zero-byte digest for a
 * perfectly good PDF. Treating it as a real digest would report those sessions
 * as permanently stale, so it is normalized away on both read and write.
 */
function realSha(hex: string | undefined): string | undefined {
  return hex && hex !== EMPTY_SHA256 ? hex : undefined;
}

/** Path of `target` relative to the sidecar's directory, POSIX-normalized. */
function relFromSidecar(sidecar: string, target: string): string {
  const rel = path.relative(path.dirname(sidecar), target);
  return rel.split(path.sep).join("/");
}

/** Resolve a sidecar-relative path back to an absolute one. */
function absFromSidecar(sidecar: string, rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(path.dirname(sidecar), rel.split("/").join(path.sep));
}

function cleanUndefined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

/** An anchor with its empty fields dropped, or undefined when nothing is set. */
function cleanAnchor(a: SourceAnchor | undefined): SourceAnchor | undefined {
  if (!a) return undefined;
  const out = cleanUndefined({
    marker: a.marker || undefined,
    blockId: a.blockId || undefined,
    blockFingerprint: a.blockFingerprint || undefined,
    contextBefore: a.contextBefore || undefined,
    contextAfter: a.contextAfter || undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

/**
 * The revision a sidecar without one belongs to.
 *
 * Every v1/v2 sidecar predates rounds, so it is by definition the first: it is
 * the only mapping that document has, and the next round the author starts
 * becomes revision 2 on top of it.
 */
export function defaultRevision(): RevisionInfo {
  return { id: "rev-1", ordinal: 1 };
}

/**
 * The mapping identity of a sidecar that predates them: its own file name, which
 * is exactly how the author has been recognizing it (`chapter-01.review.json`
 * → `chapter-01`).
 */
export function defaultMapping(sidecarPath: string): MappingInfo {
  const id =
    path.basename(sidecarPath).replace(/\.review\.json$/i, "") || "review";
  return { id, kind: "annotations" };
}

/** The PDF metadata of a sidecar that predates it — all of them were annotated. */
function defaultPdfInfo(): PdfInfo {
  return { role: "annotated" };
}

/** Coerce unknown input to a known PDF role, defaulting to `annotated`. */
function asRole(v: unknown): PdfRole {
  const roles: PdfRole[] = ["annotated", "proof", "clean", "stamped", "other"];
  return roles.includes(v as PdfRole) ? (v as PdfRole) : "annotated";
}

/** Coerce unknown input to a known mapping kind. */
function asMappingKind(v: unknown): MappingKind {
  const kinds: MappingKind[] = ["annotations", "manual", "other"];
  return kinds.includes(v as MappingKind) ? (v as MappingKind) : "annotations";
}

/** Copy a reply thread, dropping malformed entries. Undefined when empty. */
function cleanReplies(replies: Reply[] | undefined): Reply[] | undefined {
  if (!replies?.length) return undefined;
  const out = replies
    .filter((r) => r && typeof r.body === "string" && r.body.length > 0)
    .map((r) => ({
      id: r.id,
      author: r.author,
      createdAt: r.createdAt,
      body: r.body,
    }));
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Serialize: in-memory session -> on-disk v3 document
// ---------------------------------------------------------------------------

/**
 * Build the portable v3 document for `session`, with paths made relative to the
 * sidecar at `sidecarPath`. Fingerprints are pulled from `session.integrity`
 * when present (populated by the store when it reads the files).
 */
export function toDocument(
  session: ReviewSession,
  sidecarPath: string
): ReviewDocumentV3 {
  const integ = session.integrity ?? {};
  const source: FileRefDoc = cleanUndefined({
    path: relFromSidecar(sidecarPath, session.adocPath),
    sha256: realSha(integ.sourceSha256),
    bytes: integ.sourceBytes,
  });
  const pdfInfo = session.pdf ?? defaultPdfInfo();
  const pdf: PdfRefDoc = cleanUndefined({
    path: relFromSidecar(sidecarPath, session.pdfPath),
    sha256: realSha(integ.pdfSha256),
    bytes: undefined,
    annotationCount: integ.pdfAnnotationCount,
    role: pdfInfo.role ?? "annotated",
    imported: pdfInfo.imported || undefined,
    importedFrom: pdfInfo.importedFrom
      ? relFromSidecar(sidecarPath, pdfInfo.importedFrom)
      : undefined,
  });
  const rev = session.revision ?? defaultRevision();
  const revision: RevisionDoc = cleanUndefined({
    id: rev.id,
    ordinal: rev.ordinal,
    label: rev.label || undefined,
    receivedAt: rev.receivedAt || undefined,
    note: rev.note || undefined,
  });
  const map = session.mapping ?? defaultMapping(sidecarPath);
  const mapping: MappingDoc = cleanUndefined({
    id: map.id,
    kind: map.kind ?? "annotations",
    label: map.label || undefined,
    origin: map.origin || undefined,
    reviewer: map.reviewer || undefined,
    reviewType: map.reviewType || undefined,
    createdAt: map.createdAt || undefined,
  });
  const artifacts: ArtifactDoc[] | undefined = session.artifacts?.length
    ? session.artifacts.map((a) =>
        cleanUndefined({
          kind: a.kind,
          path: relFromSidecar(sidecarPath, a.path),
          createdAt: a.createdAt || undefined,
          note: a.note || undefined,
        })
      )
    : undefined;

  const items: ItemDoc[] = session.items.map((it) => {
    const annotation: AnnotationDoc = cleanUndefined({
      kind: it.kind,
      author: it.author,
      comment: it.comment || undefined,
      anchoredText: it.anchoredText || undefined,
      markedText: it.markedText,
      beforeText: it.beforeText,
      geometry: {
        page: it.page,
        unit: "pt",
        origin: "bottom-left",
        rect: it.rect,
      },
    });
    const match: MatchDoc | null = it.match
      ? cleanUndefined({
          startLine: it.match.startLine,
          endLine: it.match.endLine,
          score: it.match.score,
          method: it.match.method,
          sourceExcerpt: it.match.sourceExcerpt,
        })
      : null;
    const state: StateDoc = cleanUndefined({
      resolved: !!it.resolved,
      confirmed: it.confirmed || undefined,
      stale: it.stale || undefined,
      manualLine: it.manualLine,
      note: it.note,
      replies: cleanReplies(it.replies),
    });
    return cleanUndefined({
      id: it.id,
      annotation,
      anchor: cleanAnchor(it.anchor),
      match,
      state,
    }) as ItemDoc;
  });

  return cleanUndefined({
    $schema: SCHEMA_URL,
    version: FORMAT_VERSION,
    producer: { ...PRODUCER },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revision,
    mapping,
    source,
    pdf,
    artifacts,
    items,
  }) as ReviewDocumentV3;
}

/** Serialize a session to the pretty-printed JSON written to the sidecar. */
export function serialize(session: ReviewSession, sidecarPath: string): string {
  return JSON.stringify(toDocument(session, sidecarPath), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Parse: on-disk document (v1, v2 or v3) -> in-memory session
// ---------------------------------------------------------------------------

/**
 * Parse a sidecar's JSON text into an in-memory session, migrating v1 and v2 in
 * the process. `sidecarPath` is needed to resolve relative paths and as the
 * canonical location of the file. `adocPath` is the real source path the store
 * opened; it always wins over what the file records, so a moved/renamed sidecar
 * still binds to the right document. Omit it to take the source the file names
 * — how workspace discovery finds the manuscript a sidecar under `.eddie/`
 * belongs to. Returns null for unrecognized input.
 */
export function parse(
  text: string,
  sidecarPath: string,
  adocPath?: string
): ReviewSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const version = (raw as { version?: unknown }).version;
  if (version === 3)
    return fromV3(raw as ReviewDocumentV3, sidecarPath, adocPath);
  if (version === 2)
    return fromV2(raw as ReviewDocumentV2, sidecarPath, adocPath);
  if (version === 1) return fromV1(raw as ReviewDocumentV1, sidecarPath, adocPath);
  return null;
}

/**
 * The absolute `.adoc` path a sidecar names, without paying for a full parse of
 * its items. Workspace discovery uses this to bind a sidecar in the review
 * folder back to its manuscript — the file name no longer says which one it is.
 * Undefined for a v1 file, whose recorded path is absolute and from another
 * machine as often as not.
 */
export function resolveSourcePath(
  text: string,
  sidecarPath: string
): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const doc = raw as { version?: unknown; source?: { path?: unknown } };
  if (doc?.version !== 2 && doc?.version !== 3) return undefined;
  const rel = doc.source?.path;
  return typeof rel === "string" && rel
    ? absFromSidecar(sidecarPath, rel)
    : undefined;
}

/** Read the item array shared by the v2 and v3 documents. */
function itemsFromDoc(doc: {
  items?: ItemDoc[];
}): ReviewItem[] {
  return (doc.items ?? []).map((d) => {
    const a = d.annotation ?? ({} as AnnotationDoc);
    const g = a.geometry ?? ({} as GeometryDoc);
    const s = d.state ?? ({ resolved: false } as StateDoc);
    return cleanUndefined({
      id: d.id,
      kind: a.kind ?? "other",
      page: g.page ?? 1,
      comment: a.comment ?? "",
      anchoredText: a.anchoredText ?? "",
      markedText: a.markedText,
      beforeText: a.beforeText,
      author: a.author,
      rect: g.rect ?? [0, 0, 0, 0],
      match: d.match ?? null,
      resolved: !!s.resolved,
      confirmed: s.confirmed || undefined,
      stale: s.stale || undefined,
      manualLine: s.manualLine,
      note: s.note,
      replies: cleanReplies(s.replies),
      anchor: cleanAnchor(d.anchor),
    }) as ReviewItem;
  });
}

/** Integrity block shared by the v2 and v3 documents. */
function integrityFromDoc(doc: {
  source?: FileRefDoc;
  pdf?: PdfRefDoc;
}): SessionIntegrity {
  return cleanUndefined({
    sourceSha256: realSha(doc.source?.sha256),
    sourceBytes: doc.source?.bytes,
    pdfSha256: realSha(doc.pdf?.sha256),
    pdfAnnotationCount: doc.pdf?.annotationCount,
  });
}

/**
 * The source path to bind to: what the caller opened, else what the file names,
 * else nothing — a sidecar whose manuscript cannot be located is not loadable.
 */
function sourceOf(
  doc: { source?: FileRefDoc },
  sidecarPath: string,
  adocPath?: string
): string {
  if (adocPath) return adocPath;
  return doc.source?.path ? absFromSidecar(sidecarPath, doc.source.path) : "";
}

function fromV3(
  doc: ReviewDocumentV3,
  sidecarPath: string,
  adocPath?: string
): ReviewSession {
  const rev = doc.revision;
  const map = doc.mapping;
  const fallbackMapping = defaultMapping(sidecarPath);
  return {
    version: 3,
    sidecarPath,
    adocPath: sourceOf(doc, sidecarPath, adocPath),
    pdfPath: doc.pdf?.path ? absFromSidecar(sidecarPath, doc.pdf.path) : "",
    revision: rev?.id
      ? cleanUndefined({
          id: rev.id,
          ordinal: rev.ordinal ?? 1,
          label: rev.label,
          receivedAt: rev.receivedAt,
          note: rev.note,
        })
      : defaultRevision(),
    mapping: cleanUndefined({
      id: map?.id || fallbackMapping.id,
      kind: asMappingKind(map?.kind),
      label: map?.label,
      origin: map?.origin,
      reviewer: map?.reviewer,
      reviewType: map?.reviewType,
      createdAt: map?.createdAt,
    }),
    pdf: cleanUndefined({
      role: asRole(doc.pdf?.role),
      imported: doc.pdf?.imported || undefined,
      importedFrom: doc.pdf?.importedFrom
        ? absFromSidecar(sidecarPath, doc.pdf.importedFrom)
        : undefined,
    }),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    integrity: integrityFromDoc(doc),
    artifacts: doc.artifacts?.length
      ? doc.artifacts.map((a) =>
          cleanUndefined({
            kind: a.kind,
            path: absFromSidecar(sidecarPath, a.path),
            createdAt: a.createdAt,
            note: a.note,
          })
        )
      : undefined,
    items: itemsFromDoc(doc),
  };
}

/**
 * A v2 sidecar predates rounds: it is the sole mapping of the document's first
 * revision, named after its own file. The next write upgrades it to v3 in place,
 * wherever it currently sits — moving it into the review folder is a separate,
 * explicit command.
 */
function fromV2(
  doc: ReviewDocumentV2,
  sidecarPath: string,
  adocPath?: string
): ReviewSession {
  return {
    version: 2,
    sidecarPath,
    adocPath: sourceOf(doc, sidecarPath, adocPath),
    pdfPath: doc.pdf?.path ? absFromSidecar(sidecarPath, doc.pdf.path) : "",
    revision: defaultRevision(),
    mapping: defaultMapping(sidecarPath),
    pdf: defaultPdfInfo(),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    integrity: integrityFromDoc(doc),
    items: itemsFromDoc(doc),
  };
}

function fromV1(
  doc: ReviewDocumentV1,
  sidecarPath: string,
  adocPath?: string
): ReviewSession {
  const items: ReviewItem[] = (doc.items ?? []).map((it) =>
    cleanUndefined({
      id: it.id,
      kind: it.kind,
      page: it.page,
      comment: it.comment ?? "",
      anchoredText: it.anchoredText ?? "",
      markedText: it.markedText,
      beforeText: it.beforeText,
      author: it.author,
      rect: it.rect,
      match: it.match ?? null,
      resolved: !!it.resolved,
      confirmed: it.confirmed || undefined,
      manualLine: it.manualLine,
      note: it.note,
    }) as ReviewItem
  );

  return {
    // Loaded as v1; the next persist() rewrites it as v3.
    version: 1,
    sidecarPath,
    adocPath: adocPath ?? doc.adocPath ?? "",
    pdfPath: doc.pdfPath ?? "",
    revision: defaultRevision(),
    mapping: defaultMapping(sidecarPath),
    pdf: defaultPdfInfo(),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    items,
  };
}
