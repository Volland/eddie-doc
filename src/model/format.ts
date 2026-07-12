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
 * See `docs/FORMAT.md` for the human-readable spec and
 * `schema/review-v2.schema.json` for the JSON Schema.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  AnnotationKind,
  Match,
  ReviewItem,
  ReviewSession,
} from "./types.js";

/** Canonical identifier of the current format; also the `$schema` value. */
export const SCHEMA_URL =
  "https://volland.github.io/eddie-doc/schema/review-v2.schema.json";

/** On-disk format version this build reads and writes. */
export const FORMAT_VERSION = 2 as const;

/**
 * Producer stamp written into every sidecar. Keep the version in sync with
 * package.json (release.sh bumps both).
 */
export const PRODUCER = { name: "eddie-doc", version: "0.1.6" } as const;

// ---------------------------------------------------------------------------
// On-disk document shape (version 2)
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

/** The PDF input, with an extra annotation count for quick staleness checks. */
export interface PdfRefDoc extends FileRefDoc {
  annotationCount?: number;
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
  method?: "fuzzy" | "semantic";
  /** Non-authoritative snapshot of the matched source text, for display only. */
  sourceExcerpt?: string;
}

/** The user-owned review state — the only part a human edits over time. */
export interface StateDoc {
  resolved: boolean;
  /** User has vouched for the link (hand-picked or accepted a weak match). */
  confirmed?: boolean;
  /** 0-based line the user manually linked to; overrides `match`. */
  manualLine?: number;
  note?: string;
}

/** One review item on disk: PDF annotation + match cache + review state. */
export interface ItemDoc {
  /** Stable id, ideally the PDF annotation id; falls back to page+geometry. */
  id: string;
  annotation: AnnotationDoc;
  match: MatchDoc | null;
  state: StateDoc;
}

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

// ---------------------------------------------------------------------------
// Serialize: in-memory session -> on-disk v2 document
// ---------------------------------------------------------------------------

/**
 * Build the portable v2 document for `session`, with paths made relative to the
 * sidecar at `sidecarPath`. Fingerprints are pulled from `session.integrity`
 * when present (populated by the store when it reads the files).
 */
export function toDocument(
  session: ReviewSession,
  sidecarPath: string
): ReviewDocumentV2 {
  const integ = session.integrity ?? {};
  const source: FileRefDoc = cleanUndefined({
    path: relFromSidecar(sidecarPath, session.adocPath),
    sha256: integ.sourceSha256,
    bytes: integ.sourceBytes,
  });
  const pdf: PdfRefDoc = cleanUndefined({
    path: relFromSidecar(sidecarPath, session.pdfPath),
    sha256: integ.pdfSha256,
    bytes: undefined,
    annotationCount: integ.pdfAnnotationCount,
  });

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
      manualLine: it.manualLine,
      note: it.note,
    });
    return { id: it.id, annotation, match, state };
  });

  return {
    $schema: SCHEMA_URL,
    version: FORMAT_VERSION,
    producer: { ...PRODUCER },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    source,
    pdf,
    items,
  };
}

/** Serialize a session to the pretty-printed JSON written to the sidecar. */
export function serialize(session: ReviewSession, sidecarPath: string): string {
  return JSON.stringify(toDocument(session, sidecarPath), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Parse: on-disk document (v1 or v2) -> in-memory session
// ---------------------------------------------------------------------------

/**
 * Parse a sidecar's JSON text into an in-memory session, migrating v1 in the
 * process. `sidecarPath` is needed to resolve relative paths (v2) and as the
 * canonical location of the file. `adocPath` is the real source path the store
 * opened; it always wins over what the file records, so a moved/renamed sidecar
 * still binds to the right document. Returns null for unrecognized input.
 */
export function parse(
  text: string,
  sidecarPath: string,
  adocPath: string
): ReviewSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const version = (raw as { version?: unknown }).version;
  if (version === 2) return fromV2(raw as ReviewDocumentV2, sidecarPath, adocPath);
  if (version === 1) return fromV1(raw as ReviewDocumentV1, adocPath);
  return null;
}

function fromV2(
  doc: ReviewDocumentV2,
  sidecarPath: string,
  adocPath: string
): ReviewSession {
  const items: ReviewItem[] = (doc.items ?? []).map((d) => {
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
      manualLine: s.manualLine,
      note: s.note,
    }) as ReviewItem;
  });

  return {
    version: 2,
    adocPath,
    pdfPath: doc.pdf?.path
      ? absFromSidecar(sidecarPath, doc.pdf.path)
      : "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    integrity: cleanUndefined({
      sourceSha256: doc.source?.sha256,
      sourceBytes: doc.source?.bytes,
      pdfSha256: doc.pdf?.sha256,
      pdfAnnotationCount: doc.pdf?.annotationCount,
    }),
    items,
  };
}

function fromV1(doc: ReviewDocumentV1, adocPath: string): ReviewSession {
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
    // Loaded as v1; the next persist() rewrites it as v2.
    version: 1,
    adocPath,
    pdfPath: doc.pdfPath ?? "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    items,
  };
}
