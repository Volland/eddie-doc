/**
 * Which editor lines carry which annotations, as plain data.
 *
 * The CodeMirror extension turns this into decorations; keeping the decision
 * here means it can be tested without an editor. Lines are 1-based because that
 * is what CodeMirror uses; the core's are 0-based.
 */
import { bucketOf, itemSpan } from "../../../core/view/annotationView.js";
import type { ReviewItem } from "../../../core/model/types.js";

export interface LineMark {
  /** 1-based line number. */
  line: number;
  /** Annotations covering the line, in reading order. */
  ids: string[];
  /** Ids of the annotations that *start* on this line (they get the gutter badge). */
  startIds: string[];
  /** Remark numbers of those that start here, for the gutter. */
  numbers: number[];
  /** Kinds of those that start here, for the end-of-line marker. */
  kinds: string[];
  /** CSS class: open work wins over resolved, so a line is only grey when all are. */
  state: "open" | "review" | "resolved";
}

export interface Markup {
  lines: Map<number, LineMark>;
  count: number;
}

const RANK = { review: 2, open: 1, resolved: 0 } as const;

// @lat: [[obsidian#Editor markup#Mapping a line to a mark]]
/**
 * @param docLines number of lines in the document; spans are clamped to it so a
 *   stale mapping can never decorate a line that does not exist.
 */
export function buildMarkup(
  items: ReviewItem[],
  docLines: number,
  opts: { highConfidence: number; showResolved: boolean }
): Markup {
  const lines = new Map<number, LineMark>();
  let count = 0;
  for (const it of items) {
    if (it.resolved && !opts.showResolved) continue;
    const span = itemSpan(it);
    if (!span || span.start >= docLines) continue;
    const bucket = bucketOf(it, opts.highConfidence);
    const state: LineMark["state"] =
      bucket === "resolved" ? "resolved" : bucket === "review" ? "review" : "open";
    const end = Math.min(span.end, docLines - 1);
    count++;
    for (let l0 = span.start; l0 <= end; l0++) {
      const line = l0 + 1;
      const mark = lines.get(line) ?? { line, ids: [], startIds: [], numbers: [], kinds: [], state };
      mark.ids.push(it.id);
      if (l0 === span.start) {
        mark.startIds.push(it.id);
        mark.kinds.push(it.kind);
        if (it.number != null) mark.numbers.push(it.number);
      }
      if (RANK[state] > RANK[mark.state]) mark.state = state;
      lines.set(line, mark);
    }
  }
  return { lines, count };
}

/** Annotations covering `line` (1-based), for hover and the editor menu. */
export function idsAtLine(markup: Markup, line: number): string[] {
  return markup.lines.get(line)?.ids ?? [];
}
