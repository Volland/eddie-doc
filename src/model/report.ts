/**
 * Render a review session as a human-readable Markdown report — the artifact an
 * author sends back to their editor: what was handled, what's still open, and
 * what the matcher couldn't place. Pure over the domain model (no `vscode`),
 * so the extension command, the CLI and tests all share one renderer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveLine } from "../matching/mapper.js";
import { sha256 } from "./format.js";
import { KIND_LABEL, type ReviewItem, type ReviewSession } from "./types.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

export interface ReportOptions {
  /** Score at/above which an auto-match counts as confident (mirrors the tree). */
  highConfidence?: number;
  /** Include the resolved section (default true). */
  includeResolved?: boolean;
  /** Warn that the inputs changed since mapping ran. */
  stale?: boolean;
  /** Timestamp printed in the header; defaults to `session.updatedAt`. */
  generatedAt?: string;
}

/** A link we trust: hand-picked, confirmed, or a high-confidence auto-match. */
function isConfident(item: ReviewItem, highConf: number): boolean {
  if (item.manualLine != null || item.confirmed) return true;
  return (item.match?.score ?? 0) >= highConf;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function quote(s: string, max = 300): string {
  const c = clean(s);
  return c.length > max ? c.slice(0, max) + "…" : c;
}

function locationLabel(item: ReviewItem): string {
  const line = effectiveLine(item);
  if (line === UNMATCHED) return "no source match";
  const m = item.match;
  const span =
    m && m.endLine > m.startLine && item.manualLine == null
      ? `lines ${m.startLine + 1}–${m.endLine + 1}`
      : `line ${line + 1}`;
  if (item.manualLine != null) return `${span} · manual`;
  if (!m) return span;
  const method = m.method && m.method !== "fuzzy" ? `${m.method} ` : "";
  return `${span} · ${method}${m.score.toFixed(2)}`;
}

function renderItem(item: ReviewItem): string {
  const head = [
    `**${KIND_LABEL[item.kind]}**`,
    `p${item.page}`,
    locationLabel(item),
    item.author ? item.author : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`- ${head}`];
  if (item.comment) lines.push(`  > ${quote(item.comment)}`);
  const marked = item.markedText || item.anchoredText;
  if (marked) lines.push(`  - marked: “${quote(marked, 160)}”`);
  if (item.match?.sourceExcerpt) {
    lines.push(`  - source: \`${quote(item.match.sourceExcerpt, 160)}\``);
  }
  if (item.note) lines.push(`  - note: ${quote(item.note)}`);
  return lines.join("\n");
}

function section(title: string, items: ReviewItem[]): string[] {
  if (!items.length) return [];
  return [`## ${title} (${items.length})`, "", ...items.map(renderItem), ""];
}

/** Render `session` as a Markdown document. */
export function renderReport(
  session: ReviewSession,
  opts: ReportOptions = {}
): string {
  const highConf = opts.highConfidence ?? 0.75;
  const includeResolved = opts.includeResolved ?? true;

  const items = session.items;
  const unresolved = items.filter((i) => !i.resolved);
  const located = unresolved.filter((i) => effectiveLine(i) !== UNMATCHED);
  const open = located.filter((i) => isConfident(i, highConf));
  const review = located.filter((i) => !isConfident(i, highConf));
  const unmatched = unresolved.filter((i) => effectiveLine(i) === UNMATCHED);
  const resolved = items.filter((i) => i.resolved);

  const sourceName = path.basename(session.adocPath);
  const pdfName = session.pdfPath ? path.basename(session.pdfPath) : "(unknown)";

  const out: string[] = [
    `# Review report — ${sourceName}`,
    "",
    `- **Source:** \`${sourceName}\``,
    `- **Annotated PDF:** \`${pdfName}\``,
    `- **Generated:** ${opts.generatedAt ?? session.updatedAt}`,
    `- **Progress:** ${resolved.length} of ${items.length} resolved · ` +
      `${open.length} open · ${review.length} need review · ` +
      `${unmatched.length} unmatched`,
    "",
  ];
  if (opts.stale) {
    out.push(
      "> ⚠️ The source or PDF changed after this mapping ran — line numbers " +
        "may be off. Re-run **Re-map Annotations** before relying on them.",
      ""
    );
  }

  out.push(...section("Open", open));
  out.push(...section("Needs review", review));
  out.push(...section("Unmatched", unmatched));
  if (includeResolved) out.push(...section("Resolved", resolved));

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * True when the sidecar's recorded input fingerprints no longer match the
 * files on disk (or the files can't be read). Missing fingerprints — e.g. a
 * freshly-migrated v1 session — count as not stale: there is nothing to
 * compare against.
 */
export function isSessionStale(session: ReviewSession): boolean {
  const integ = session.integrity;
  if (!integ) return false;
  const differs = (file: string, expected?: string): boolean => {
    if (!expected) return false;
    try {
      return sha256(new Uint8Array(fs.readFileSync(file))) !== expected;
    } catch {
      return true;
    }
  };
  return (
    differs(session.adocPath, integ.sourceSha256) ||
    differs(session.pdfPath, integ.pdfSha256)
  );
}
