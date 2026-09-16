/**
 * Growing one mapping from several PDFs.
 *
 * Two situations put more than one PDF behind a mapping:
 *
 * - **Continuing** — the editor sends the chapter back again with more marks
 *   on it, or a second editor marks up another copy of the same pass. The new
 *   PDF's marks are *appended* to the mapping the author is already working in.
 * - **Merging** — the marks were already opened as separate mappings, and the
 *   author wants to work through them as one list. Each mapping's items, with
 *   everything the author did to them, move into a single target.
 *
 * Both must be safe to repeat. A re-sent PDF repeats every mark from the first
 * copy, and merging two mappings of the same editor's work repeats them too, so
 * a mark already present is recognised and not added twice. Nothing here
 * touches `vscode` or the file system; the store does the reading and writing.
 */
import { annotationFingerprint, bySourcePosition } from "../matching/mapper.js";
import { assignNumbers, maxNumber, readingOrder } from "./numbering.js";
import {
  markSourceName,
  type MappingInfo,
  type PdfSource,
  type ReviewItem,
  type ReviewSession,
} from "./types.js";

/** The id the next PDF added to `session` takes: `pdf-2`, `pdf-3`… */
export function nextPdfId(session: ReviewSession, reserved: string[] = []): string {
  const used = [...(session.extraPdfs ?? []).map((p) => p.id), ...reserved];
  let n = 2; // the mapping's own PDF is the first
  for (const id of used) {
    const m = /^pdf-(\d+)$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `pdf-${n}`;
}

/**
 * An item id from an added PDF. Ids derive from page and geometry, so two
 * copies of the same chapter produce the same ids for marks in the same place —
 * namespacing by PDF keeps them apart, and stays stable across re-maps.
 */
export function namespacedId(pdfId: string | undefined, rawId: string): string {
  return pdfId ? `${pdfId}/${rawId}` : rawId;
}

/** The id the item had in its own PDF, before namespacing. */
export function rawIdOf(item: ReviewItem): string {
  const prefix = item.pdfId ? `${item.pdfId}/` : "";
  return prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}

/**
 * What makes two marks the same remark: who made it, what kind, the words, and
 * the page. The page is included because copy editors repeat themselves — the
 * same bare "delete" strikeout over the same boilerplate line on two pages is
 * two remarks, not one.
 */
export function sameRemarkKey(item: ReviewItem): string {
  return `${annotationFingerprint(item)}@${item.page}`;
}

/** A multiset of remark keys, so N copies of a mark absorb at most N repeats. */
function keyCounts(items: ReviewItem[]): Map<string, ReviewItem[]> {
  const out = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const k = sameRemarkKey(it);
    const q = out.get(k);
    if (q) q.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/** What appending a PDF's marks did. */
export interface AppendOutcome {
  /** Marks new to the mapping, now part of it. */
  added: ReviewItem[];
  /** Marks the mapping already had, from an earlier copy of the same PDF. */
  duplicates: number;
}

/**
 * Append a PDF's freshly mapped items to `session` as PDF `source`.
 *
 * Marks the mapping already holds are skipped. New marks take the next free
 * numbers in reading order, so everything the author has already quoted keeps
 * its number. The source is recorded even when every mark was a repeat: it is
 * still a PDF the mapping has seen, and seeing it again is then recognisable.
 */
export function appendItems(
  session: ReviewSession,
  source: PdfSource,
  incoming: ReviewItem[],
  fallbackName: (item: ReviewItem) => string | undefined = () => undefined
): AppendOutcome {
  const existing = keyCounts(session.items);
  const added: ReviewItem[] = [];
  let duplicates = 0;
  for (const it of incoming.slice().sort(readingOrder)) {
    const q = existing.get(sameRemarkKey(it));
    if (q?.length) {
      q.shift();
      duplicates++;
      continue;
    }
    added.push({
      ...it,
      id: namespacedId(source.id, rawIdOf(it)),
      pdfId: source.id,
      number: undefined,
      initials: undefined,
    });
  }

  session.extraPdfs = [...(session.extraPdfs ?? []), source];
  session.items = [...session.items, ...added].sort(bySourcePosition);
  assignNumbers(session.items, fallbackName);
  return { added, duplicates };
}

/** What merging mappings into one did. */
export interface MergeOutcome {
  /** Items moved into the target as new remarks. */
  moved: number;
  /** Items that repeated a remark the target had; their state was folded in. */
  folded: number;
  /** PDFs the target now also draws from. */
  pdfsAdded: number;
}

/**
 * Fold `others` into `target`: their PDFs become added PDFs of the target and
 * their items move across with their review state — resolved, notes, replies,
 * anchors and hand-made links alike.
 *
 * The target's numbers are untouched. Each merged mapping's items follow in
 * the order of their old numbers, so a list the author was working through
 * stays in the same order, just further down.
 *
 * A remark the target already has is not duplicated; whatever the author did
 * to the other copy is folded into the target's, so no reply or resolution is
 * lost in the merge.
 */
export function mergeInto(
  target: ReviewSession,
  others: ReviewSession[],
  now: string = new Date().toISOString()
): MergeOutcome {
  let moved = 0;
  let folded = 0;
  let pdfsAdded = 0;
  const fallback = markSourceName;

  for (const other of others) {
    // Numbers and initials were settled in the other mapping; settle any gaps
    // there first, so the merged order follows what the author saw.
    assignNumbers(other.items, (it) => fallback(other, it));

    // Every PDF behind the other mapping becomes an added PDF of the target.
    const renamed = new Map<string | undefined, string>();
    const reserved: string[] = [];
    const sources: PdfSource[] = [];
    const add = (from: string | undefined, src: Omit<PdfSource, "id">) => {
      const id = nextPdfId(target, reserved);
      reserved.push(id);
      renamed.set(from, id);
      sources.push({ id, ...src });
    };
    add(undefined, {
      path: other.pdfPath,
      role: other.pdf?.role ?? "annotated",
      imported: other.pdf?.imported,
      importedFrom: other.pdf?.importedFrom,
      sha256: other.integrity?.pdfSha256,
      annotationCount: other.integrity?.pdfAnnotationCount,
      addedAt: now,
      ...whoMarked(other.mapping),
    });
    for (const p of other.extraPdfs ?? []) {
      const { id, ...rest } = p;
      add(id, {
        ...rest,
        origin: rest.origin ?? other.mapping.origin,
        reviewer: rest.reviewer ?? other.mapping.reviewer,
        addedAt: rest.addedAt ?? now,
      });
    }
    target.extraPdfs = [...(target.extraPdfs ?? []), ...sources];
    pdfsAdded += sources.length;

    const inTarget = keyCounts(target.items);
    const byOldNumber = other.items
      .slice()
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || readingOrder(a, b));
    let next = maxNumber(target.items) + 1;
    const incoming: ReviewItem[] = [];
    for (const it of byOldNumber) {
      const twin = inTarget.get(sameRemarkKey(it))?.shift();
      if (twin) {
        foldState(twin, it);
        folded++;
        continue;
      }
      const pdfId = renamed.get(it.pdfId) ?? renamed.get(undefined)!;
      incoming.push({
        ...it,
        id: namespacedId(pdfId, rawIdOf(it)),
        pdfId,
        number: next++,
        initials: it.initials,
      });
    }
    moved += incoming.length;
    target.items = [...target.items, ...incoming];

    if (other.artifacts?.length) {
      target.artifacts = [...(target.artifacts ?? []), ...other.artifacts];
    }
  }

  target.items.sort(bySourcePosition);
  assignNumbers(target.items, (it) => fallback(target, it));
  return { moved, folded, pdfsAdded };
}

/** The mapping's attribution, carried onto a PDF it no longer owns. */
function whoMarked(m: MappingInfo): Pick<PdfSource, "origin" | "reviewer"> {
  return {
    origin: m.origin || m.label || undefined,
    reviewer: m.reviewer || undefined,
  };
}

/**
 * Give `into` whatever the author did to its twin: nothing already there is
 * overwritten, and nothing only the twin had is lost.
 */
export function foldState(into: ReviewItem, from: ReviewItem): void {
  into.resolved = into.resolved || from.resolved;
  into.confirmed = into.confirmed || from.confirmed || undefined;
  into.manualLine = into.manualLine ?? from.manualLine;
  into.anchor = into.anchor ?? from.anchor;
  if (from.note && from.note !== into.note) {
    into.note = into.note ? `${into.note}\n\n${from.note}` : from.note;
  }
  if (from.replies?.length) {
    const have = new Set((into.replies ?? []).map((r) => r.id));
    const extra = from.replies.filter((r) => !have.has(r.id));
    if (extra.length) {
      into.replies = [...(into.replies ?? []), ...extra].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
    }
  }
}
