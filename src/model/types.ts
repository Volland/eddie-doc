/** Domain model shared by the PDF-extraction, matching, and UI layers. */

/** Normalized annotation kinds we care about, derived from PDF subtypes. */
export type AnnotationKind =
  | "highlight"
  | "strikeout"
  | "underline"
  | "comment" // sticky note / popup text
  | "insert" // caret: proposed insertion
  | "replace" // strike + inserted text
  | "other";

/** A raw annotation as pulled from the PDF, before mapping to source. */
export interface RawAnnotation {
  /** Stable id, derived from page + geometry so re-runs keep the same ids. */
  id: string;
  kind: AnnotationKind;
  /** 1-based page number in the PDF. */
  page: number;
  /** The editor's comment body, if any. */
  comment: string;
  /** Text physically under the markup (highlight/strikeout/underline). */
  anchoredText: string;
  /**
   * The tightly-bounded text actually inside the markup quads — narrower than
   * `anchoredText`, which over-captures a full line for robust matching. Used
   * for character-level edits (precise delete / replace).
   */
  markedText?: string;
  /**
   * For caret/insert marks: the text on the same line to the LEFT of the caret,
   * used to place an insertion at the exact character offset.
   */
  beforeText?: string;
  /** Author, if the PDF records it. */
  author?: string;
  /** Annotation rectangle [x1,y1,x2,y2] in PDF points (bottom-left origin). */
  rect: [number, number, number, number];
}

/**
 * How a match was produced, in descending order of trust.
 *
 * The first three are *deterministic* — they resolve an identity that was
 * recorded in the source, so they are not similarity scores at all and always
 * beat the searching tiers below them:
 * - `marker`      — an `// eddie:<id>` comment line was found in the source.
 * - `blockId`     — the enclosing `[#id]` AsciiDoc block was found.
 * - `fingerprint` — the enclosing block hashed to the value recorded at map time.
 *
 * The rest search for similar text and can be wrong:
 * - `fuzzy`    — token/bigram window match.
 * - `semantic` — embedding similarity (opt-in, needs Ollama).
 * - `lexical`  — character-trigram containment.
 */
export type MatchMethod =
  | "marker"
  | "blockId"
  | "fingerprint"
  | "fuzzy"
  | "semantic"
  | "lexical";

/** Methods that resolve a recorded identity rather than guessing by similarity. */
export const DETERMINISTIC_METHODS: readonly MatchMethod[] = [
  "marker",
  "blockId",
  "fingerprint",
];

/** True when `method` resolved a recorded identity, so its score is not a guess. */
export function isDeterministic(method: MatchMethod | undefined): boolean {
  return method !== undefined && DETERMINISTIC_METHODS.includes(method);
}

/** Result of matching a raw annotation against the AsciiDoc source. */
export interface Match {
  /** 0-based start line in the source document. */
  startLine: number;
  /** 0-based end line (inclusive). */
  endLine: number;
  /** 0-1 similarity of the best matched span. 1 for deterministic methods. */
  score: number;
  /** The source text span that matched (for display / debugging). */
  sourceExcerpt: string;
  /** How the match was produced. See {@link MatchMethod}. */
  method?: MatchMethod;
}

/** One entry in an item's reply thread — the author answering the editor. */
export interface Reply {
  /** Stable id so an edit or delete addresses exactly one reply. */
  id: string;
  /** Display name of the replier. */
  author: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** The reply text. */
  body: string;
}

/**
 * A durable, edit-resistant binding of an item to a place in the source.
 *
 * Line numbers go stale the moment someone edits outside the extension, and
 * matching the editor's (now-outdated) PDF text against rewritten prose is
 * unreliable — it is what produces sub-0.7 scores and wrong anchors. This block
 * records identities that *travel with the text itself*, so re-mapping can
 * resolve them instead of searching. Populated by the anchor command; every
 * field is optional because an un-anchored session has none of them.
 */
export interface SourceAnchor {
  /** Id of the `// eddie:<id>` marker comment injected into the source. */
  marker?: string;
  /** Id of the enclosing AsciiDoc block (`[#ch04-figure-anatomy]`), if any. */
  blockId?: string;
  /** Truncated SHA-256 of the normalized enclosing block text at anchor time. */
  blockFingerprint?: string;
  /** A few normalized words before the anchored block, for last-ditch matching. */
  contextBefore?: string;
  /** A few normalized words after the anchored block. */
  contextAfter?: string;
}

/** A fully-resolved review item: annotation + where it lives in source + state. */
export interface ReviewItem extends RawAnnotation {
  match: Match | null;
  resolved: boolean;
  /** Set when the user manually re-links; overrides the fuzzy match. */
  manualLine?: number;
  /**
   * User has vouched for this link (manual re-select, or accepted a low-
   * confidence/semantic auto-match). Keeps it out of the "Needs review" group.
   */
  confirmed?: boolean;
  note?: string;
  /** The author's reply thread under this annotation, oldest first. */
  replies?: Reply[];
  /** Durable source binding that survives edits made outside the extension. */
  anchor?: SourceAnchor;
}

/**
 * Content fingerprints of the inputs a session was built from. Cached in memory
 * when the files are read (load / re-map) and written into the sidecar so a
 * consumer can detect that the source or PDF changed since mapping ran. All
 * fields are optional: a freshly-migrated v1 session has none until it re-maps.
 */
export interface SessionIntegrity {
  /** SHA-256 (hex) of the source `.adoc` bytes at map time. */
  sourceSha256?: string;
  /** Size of the source `.adoc` in bytes at map time. */
  sourceBytes?: number;
  /** SHA-256 (hex) of the annotated PDF bytes at map time. */
  pdfSha256?: string;
  /** Number of annotations extracted from the PDF. */
  pdfAnnotationCount?: number;
}

/**
 * In-memory per-document review session. This is the domain model the UI,
 * matching and store operate on — paths are absolute and items are flat. It is
 * serialized to / from the portable on-disk standard by `model/format.ts`; the
 * sidecar file itself is NOT this shape (see `docs/FORMAT.md`).
 */
export interface ReviewSession {
  /** On-disk format version this session most recently round-tripped through. */
  version: 1 | 2;
  /** Absolute path to the source .adoc (the store key). */
  adocPath: string;
  /** Absolute path to the annotated PDF this session was built from. */
  pdfPath: string;
  createdAt: string;
  updatedAt: string;
  /** Fingerprints of the inputs, when known. */
  integrity?: SessionIntegrity;
  items: ReviewItem[];
}

export const KIND_LABEL: Record<AnnotationKind, string> = {
  highlight: "Highlight",
  strikeout: "Delete",
  underline: "Underline",
  comment: "Comment",
  insert: "Insert",
  replace: "Replace",
  other: "Note",
};

export const KIND_ICON: Record<AnnotationKind, string> = {
  highlight: "symbol-color",
  strikeout: "trash",
  underline: "text-size",
  comment: "comment",
  insert: "add",
  replace: "replace",
  other: "note",
};
