import type { ContentChange } from "../../../core/matching/posTrack.js";

/** The slice of a CodeMirror `Text` this needs. */
interface LineSource {
  lineAt(pos: number): { number: number; from: number };
}

/** The slice of an inserted CodeMirror `Text` this needs. */
interface Inserted {
  lines: number;
  length: number;
  sliceString(from: number, to?: number): string;
}

/** The slice of a CodeMirror `ChangeSet` this needs. */
interface ChangeSource {
  iterChanges(
    f: (fromA: number, toA: number, fromB: number, toB: number, inserted: Inserted) => void
  ): void;
}

// @lat: [[obsidian#Editor markup#Live edits]]
/**
 * Reduce a CodeMirror transaction's changes to the core's `ContentChange`s.
 *
 * Positions are in the *pre-edit* document, which is what `startDoc` is.
 *
 * Two adjustments make CodeMirror's changes fit `shiftLine`'s model:
 *
 * - **Order.** CodeMirror reports ranges ascending; `shiftLine` applies changes
 *   in the order given, against the original line, which is only right when they
 *   arrive descending (the order VS Code delivers). They are reversed.
 * - **Whole lines inserted at column 0.** `shiftLine` assumes an edit's first line
 *   stays where it is, true when text goes in mid-line. Pressing Enter at the
 *   start of a paragraph inserts `"\n"` at column 0 and pushes that paragraph
 *   down, so its line must move. An insertion of whole lines at column 0 is
 *   exactly an insertion at the end of the previous line, and is reported so.
 */
export function toContentChanges(startDoc: LineSource, changes: ChangeSource): ContentChange[] {
  const out: ContentChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const from = startDoc.lineAt(fromA);
    const to = startDoc.lineAt(toA);
    let startLine = from.number - 1;
    let endLine = to.number - 1;
    const newLineCount = inserted.lines - 1;
    const pureInsert = fromA === toA;
    const wholeLines =
      pureInsert &&
      fromA === from.from &&
      from.number > 1 &&
      inserted.length > 0 &&
      inserted.sliceString(inserted.length - 1) === "\n";
    if (wholeLines) {
      startLine = endLine = startLine - 1;
    }
    out.push({ startLine, endLine, newLineCount });
  });
  return out.reverse();
}
