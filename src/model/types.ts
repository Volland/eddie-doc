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

/** Result of matching a raw annotation against the AsciiDoc source. */
export interface Match {
  /** 0-based start line in the source document. */
  startLine: number;
  /** 0-based end line (inclusive). */
  endLine: number;
  /** 0-1 similarity of the best matched span. */
  score: number;
  /** The source text span that matched (for display / debugging). */
  sourceExcerpt: string;
  /** How the match was produced: token fuzzy match or semantic embedding. */
  method?: "fuzzy" | "semantic";
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
}

/** The persisted per-document review session (sidecar `<file>.review.json`). */
export interface ReviewSession {
  version: 1;
  /** Absolute or workspace-relative path to the source .adoc. */
  adocPath: string;
  /** Path to the annotated PDF this session was built from. */
  pdfPath: string;
  createdAt: string;
  updatedAt: string;
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
