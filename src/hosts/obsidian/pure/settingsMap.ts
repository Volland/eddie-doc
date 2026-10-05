import { DEFAULT_SETTINGS, type Settings } from "../../../core/host/services.js";

/** Settings the Obsidian host adds to the shared ones. */
export interface ObsidianSettings extends Settings {
  /** `never` stops Eddie claiming `.adoc` when another plugin should own it. */
  claimAdoc: "auto" | "never";
  /**
   * `own` draws the page and the marked rectangle itself; `builtin` opens Obsidian's
   * viewer at the page. Obsidian 1.8.4's viewer lands on the right page but does not
   * draw `&rect=`, so `own` is the default.
   */
  pdfPreview: "builtin" | "own";
  /** Coordinates for the viewer's `&rect=`; flip if the highlight lands in the wrong place. */
  pdfRectMode: "pdf-user" | "top-left";
}

/**
 * Defaults where Obsidian differs from VS Code: a visible review folder (Obsidian
 * neither indexes nor syncs dot-folders) and PDFs always copied into the vault
 * (a PDF outside it cannot be read on mobile).
 */
export const OBSIDIAN_DEFAULTS: ObsidianSettings = {
  ...DEFAULT_SETTINGS,
  reviewFolder: "Eddie Reviews",
  importPdfs: true,
  claimAdoc: "auto",
  pdfPreview: "own",
  pdfRectMode: "pdf-user",
};

const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);

/** A vault-relative folder, or the default when the value could escape the vault. */
export function sanitizeReviewFolder(v: unknown): string {
  const raw = str(v, OBSIDIAN_DEFAULTS.reviewFolder).trim().replace(/\\/g, "/");
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  if (!cleaned || /^[A-Za-z]:/.test(raw) || raw.startsWith("/")) {
    return OBSIDIAN_DEFAULTS.reviewFolder;
  }
  if (cleaned.split("/").some((s) => s === "..")) return OBSIDIAN_DEFAULTS.reviewFolder;
  return cleaned;
}

// @lat: [[obsidian#Plugin shell#Settings]]
/**
 * Turn whatever `data.json` holds into valid settings. Unknown keys are dropped,
 * wrong types and out-of-range numbers fall back to the default, and the two
 * values Obsidian cannot honour otherwise are pinned.
 */
export function sanitizeSettings(raw: unknown): ObsidianSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = OBSIDIAN_DEFAULTS;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
    allowed.includes(v as T) ? (v as T) : fb;
  return {
    reviewFolder: sanitizeReviewFolder(r.reviewFolder),
    importPdfs: true, // pinned — see OBSIDIAN_DEFAULTS
    stampOutput: oneOf(r.stampOutput, ["reviewFolder", "besidePdf"] as const, d.stampOutput),
    reportOutput: oneOf(r.reportOutput, ["reviewFolder", "besideSource"] as const, d.reportOutput),
    matchThreshold: num(r.matchThreshold, d.matchThreshold),
    showResolved: bool(r.showResolved, d.showResolved),
    autoAnchor: bool(r.autoAnchor, d.autoAnchor),
    inlineMarkers: bool(r.inlineMarkers, d.inlineMarkers),
    expandThreads: bool(r.expandThreads, d.expandThreads),
    highConfidence: num(r.highConfidence, d.highConfidence),
    semanticFallback: bool(r.semanticFallback, d.semanticFallback),
    ollamaUrl: str(r.ollamaUrl, d.ollamaUrl).trim() || d.ollamaUrl,
    embedModel: str(r.embedModel, d.embedModel).trim() || d.embedModel,
    semanticThreshold: num(r.semanticThreshold, d.semanticThreshold),
    lexicalFallback: bool(r.lexicalFallback, d.lexicalFallback),
    authorName: str(r.authorName, d.authorName).trim(),
    lexicalThreshold: num(r.lexicalThreshold, d.lexicalThreshold),
    claimAdoc: oneOf(r.claimAdoc, ["auto", "never"] as const, d.claimAdoc),
    pdfPreview: oneOf(r.pdfPreview, ["builtin", "own"] as const, d.pdfPreview),
    pdfRectMode: oneOf(r.pdfRectMode, ["pdf-user", "top-left"] as const, d.pdfRectMode),
  };
}
