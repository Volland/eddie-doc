/**
 * How the CLI prints review objects: one-line rows for people, plain objects
 * for `--json`. Line numbers are 1-based here, as an editor shows them; the
 * core counts from 0.
 */
import { effectiveLine } from "../../core/matching/mapper.js";
import { bucketOf, BUCKET_LABEL, type Counts } from "../../core/view/annotationView.js";
import {
  KIND_LABEL,
  mappingLabel,
  revisionLabel,
  type ReviewItem,
  type ReviewSession,
} from "../../core/model/types.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

export function clip(s: string | undefined, n = 80): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 1-based line, or null when the item has no place. */
export function line1(item: ReviewItem): number | null {
  const l = effectiveLine(item);
  return l === UNMATCHED ? null : l + 1;
}

/** `#3 VP` — how a remark is quoted — or the id when it has no number. */
export function itemLabel(item: ReviewItem): string {
  if (item.number == null) return item.id;
  return item.initials ? `#${item.number} ${item.initials}` : `#${item.number}`;
}

export function itemRow(item: ReviewItem): string {
  const l = line1(item);
  const where = l == null ? "unmatched" : `L${l}`;
  const how =
    item.manualLine != null
      ? "manual"
      : item.match
        ? `${item.match.score.toFixed(2)} ${item.match.method ?? "fuzzy"}`
        : "";
  const flags = [item.resolved ? "resolved" : "", item.stale ? "stale" : "", item.confirmed ? "confirmed" : ""]
    .filter(Boolean)
    .join(",");
  const replies = item.replies?.length ? ` 💬${item.replies.length}` : "";
  const text = clip(item.comment || item.markedText || item.anchoredText, 70);
  return (
    `${itemLabel(item).padEnd(8)} ${`[${KIND_LABEL[item.kind]}]`.padEnd(12)} ` +
    `p${String(item.page).padEnd(3)} ${where.padEnd(10)} ${how.padEnd(14)} ` +
    `${text}${replies}${flags ? `  (${flags})` : ""}`
  );
}

export function itemJson(item: ReviewItem, highConfidence: number) {
  const l = line1(item);
  return {
    id: item.id,
    number: item.number ?? null,
    initials: item.initials ?? null,
    kind: item.kind,
    bucket: bucketOf(item, highConfidence),
    page: item.page,
    line: l,
    endLine:
      l == null ? null : item.manualLine != null ? l : (item.match?.endLine ?? l - 1) + 1,
    score: item.match?.score ?? null,
    method: item.manualLine != null ? "manual" : (item.match?.method ?? null),
    resolved: item.resolved,
    confirmed: !!item.confirmed,
    stale: !!item.stale,
    author: item.author ?? null,
    comment: item.comment,
    markedText: item.markedText ?? null,
    anchoredText: item.anchoredText,
    anchor: item.anchor?.marker ?? item.anchor?.blockId ?? null,
    replies: item.replies ?? [],
  };
}

export function countsText(c: Counts): string {
  return (
    `${c.total} annotation(s): ${c.open} ${BUCKET_LABEL.open.toLowerCase()}, ` +
    `${c.review} ${BUCKET_LABEL.review.toLowerCase()}, ${c.unmatched} unmatched, ` +
    `${c.resolved} resolved`
  );
}

export function mappingJson(s: ReviewSession, counts: Counts, active: boolean) {
  return {
    id: s.mapping.id,
    ref: `${s.revision.id}/${s.mapping.id}`,
    label: mappingLabel(s),
    round: s.revision.ordinal,
    roundLabel: s.revision.label ?? null,
    origin: s.mapping.origin ?? null,
    reviewer: s.mapping.reviewer ?? null,
    reviewType: s.mapping.reviewType ?? null,
    pdfRole: s.pdf?.role ?? null,
    sidecar: s.sidecarPath,
    source: s.adocPath,
    pdf: s.pdfPath,
    extraPdfs: (s.extraPdfs ?? []).map((p) => p.path),
    updatedAt: s.updatedAt,
    default: active,
    counts,
  };
}

export function roundTitle(s: ReviewSession): string {
  return revisionLabel(s.revision);
}
