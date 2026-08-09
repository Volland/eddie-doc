/**
 * Where review artifacts live on disk.
 *
 * A manuscript is edited over several rounds, and each round can come back as
 * more than one annotated PDF (different copy editors, different sites). That
 * turns "one sidecar next to the .adoc" into a small tree, and the manuscript
 * folder is the one place it must not grow in: authors ship that directory.
 *
 * So every artifact Eddie Doc produces goes under a single **review folder**
 * whose subtree mirrors the manuscript's:
 *
 * ```text
 * manuscript/chapter-01.adoc            ← never gains a file
 *
 * .eddie/manuscript/chapter-01/         ← everything about that chapter
 *   rev-1/
 *     acme-copyedit.review.json         ← one mapping = one annotated PDF
 *     acme-copyedit.review.md           ← its exported report
 *     pdf/acme-copyedit.pdf             ← imported / stamped PDFs (opt-in)
 *   rev-2/
 *     acme-copyedit.review.json
 *     beta-proofread.review.json        ← same round, a second reviewer
 * ```
 *
 * This module is pure path math over that shape — no `vscode`, no file system —
 * so the store, the CLI and the tests all agree on where things go.
 */
import * as path from "node:path";

/** Default review-folder setting: a dot folder at the workspace root. */
export const DEFAULT_REVIEW_FOLDER = ".eddie";

/** Suffix identifying a mapping file. */
export const SIDECAR_SUFFIX = ".review.json";

/** Suffix of an exported Markdown report. */
export const REPORT_SUFFIX = ".review.md";

/**
 * Everything the path math needs to know about the current project.
 *
 * `reviewFolder` is the raw setting: a relative path is resolved against
 * `workspaceRoot`, an absolute path is used as-is, and an empty string selects
 * the legacy layout where a sidecar sits beside its `.adoc`.
 */
export interface LayoutConfig {
  /** Absolute workspace root. Falls back to the source file's own directory. */
  workspaceRoot?: string;
  /** The `eddieDoc.reviewFolder` setting. */
  reviewFolder: string;
}

/** Absolute path of the review folder, or undefined in the legacy layout. */
export function reviewRoot(
  cfg: LayoutConfig,
  adocPath?: string
): string | undefined {
  const setting = (cfg.reviewFolder ?? "").trim();
  if (!setting) return undefined;
  if (path.isAbsolute(setting)) return path.normalize(setting);
  const base =
    cfg.workspaceRoot ?? (adocPath ? path.dirname(adocPath) : undefined);
  if (!base) return undefined;
  return path.resolve(base, setting);
}

/**
 * A path component safe to put in a folder or file name: lowercase, ASCII-ish,
 * with runs of anything else collapsed to a single dash.
 */
export function slug(text: string): string {
  const s = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "untitled";
}

/**
 * The folder holding every revision of `adocPath`, or undefined in the legacy
 * layout.
 *
 * The manuscript's directory structure is mirrored under the review root so two
 * chapters named `chapter-01.adoc` in different folders cannot collide. A source
 * outside the workspace (or on another drive) has no meaningful relative path,
 * so it falls back to a slug of its own directory.
 */
export function documentFolder(
  cfg: LayoutConfig,
  adocPath: string
): string | undefined {
  const root = reviewRoot(cfg, adocPath);
  if (!root) return undefined;
  const stem = path.basename(adocPath).replace(/\.(adoc|asciidoc|asc|ad)$/i, "");
  const base = cfg.workspaceRoot ?? path.dirname(adocPath);
  let rel = path.relative(base, path.dirname(adocPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Outside the workspace: keep it addressable without escaping the root.
    rel = slug(path.dirname(adocPath));
  }
  return path.join(root, rel, slug(stem));
}

/** Folder id for the nth revision. Ordinals are 1-based, as authors count. */
export function revisionId(ordinal: number): string {
  return `rev-${Math.max(1, Math.floor(ordinal))}`;
}

/** Ordinal encoded in a revision id, or undefined if it isn't one of ours. */
export function revisionOrdinal(id: string): number | undefined {
  const m = /^rev-(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** Folder holding one revision's mappings. */
export function revisionFolder(docFolder: string, revision: string): string {
  return path.join(docFolder, revision);
}

/** Where imported and stamped PDFs for a revision go. */
export function pdfFolder(docFolder: string, revision: string): string {
  return path.join(revisionFolder(docFolder, revision), "pdf");
}

/** Sidecar path for one mapping inside a revision. */
export function mappingSidecarPath(
  docFolder: string,
  revision: string,
  mappingId: string
): string {
  return path.join(
    revisionFolder(docFolder, revision),
    mappingId + SIDECAR_SUFFIX
  );
}

/** Report path for one mapping inside a revision. */
export function mappingReportPath(
  docFolder: string,
  revision: string,
  mappingId: string
): string {
  return path.join(
    revisionFolder(docFolder, revision),
    mappingId + REPORT_SUFFIX
  );
}

/** The pre-1.1 location: `<file>.review.json` beside the `.adoc`. */
export function legacySidecarPath(adocPath: string): string {
  return adocPath.replace(/\.(adoc|asciidoc|asc|ad)$/i, "") + SIDECAR_SUFFIX;
}

/**
 * Identity of a mapping, derived from the annotated PDF's name — the thing an
 * author recognizes it by. `taken` keeps two PDFs that slug identically from
 * fighting over one file inside the same revision.
 */
export function mappingIdFromPdf(
  pdfPath: string,
  taken: Iterable<string> = []
): string {
  const stem = path
    .basename(pdfPath)
    .replace(/\.pdf$/i, "")
    .replace(/\.(annotated|reviewed|marked|commented)$/i, "");
  return uniqueId(slug(stem), taken);
}

/** `base`, or `base-2`, `base-3`… until it is not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** True when `file` sits inside the review folder rather than the manuscript. */
export function isInReviewFolder(cfg: LayoutConfig, file: string): boolean {
  const root = reviewRoot(cfg, file);
  if (!root) return false;
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The `.adoc` a legacy sidecar belongs to, by name, or undefined. */
export function legacySourceCandidates(sidecar: string): string[] {
  const base = sidecar.replace(/\.review\.json$/i, "");
  return [base, base + ".adoc", base + ".asciidoc"];
}
