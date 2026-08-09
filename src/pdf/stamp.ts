/**
 * Write review annotations into a freshly rendered PDF.
 *
 * Asciidoctor has no concept of PDF annotations, so every rebuild starts blank.
 * This module puts the editor's marks back — re-anchored onto the current text
 * by `anchor.ts` — together with the author's replies, producing the artifact
 * that goes back to the editor while the clean render stays untouched for the
 * publisher.
 *
 * Two details are easy to get wrong and both are handled here:
 *
 * 1. **Appearance streams are not optional.** Acrobat and Chrome synthesise an
 *    appearance for a markup annotation that lacks one; Preview.app draws
 *    nothing at all. Every annotation written here carries an explicit `/AP`,
 *    so the file looks the same in all three.
 * 2. **Replies use `/IRT`.** A reply is a real annotation pointing at its
 *    parent, which is how Acrobat renders a thread. `extract.ts` already skips
 *    annotations with `inReplyTo`, so re-importing a stamped PDF next round
 *    ignores our own replies instead of mistaking them for new editorial marks.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import type { AnchoredItem } from "./anchor.js";
import { KIND_LABEL, type AnnotationKind, type ReviewItem } from "../model/types.js";

export interface StampOptions {
  /** Include resolved items, drawn faintly. Default true. */
  includeResolved?: boolean;
  /** Opacity for resolved marks. Default 0.25. */
  resolvedOpacity?: number;
  /** Author name used when a reply has none. */
  replyAuthorFallback?: string;
}

export interface StampResult {
  bytes: Uint8Array;
  /** Annotations written, excluding replies. */
  marks: number;
  /** Reply annotations written. */
  replies: number;
  /** Resolved items that were skipped because `includeResolved` was false. */
  skippedResolved: number;
}

/** Colour per mark kind, in the same family a reviewing tool would use. */
const COLOR: Record<AnnotationKind, [number, number, number]> = {
  highlight: [1.0, 0.86, 0.2],
  strikeout: [0.94, 0.35, 0.33],
  underline: [0.3, 0.62, 0.95],
  comment: [1.0, 0.78, 0.36],
  insert: [0.42, 0.78, 0.45],
  replace: [0.85, 0.5, 0.9],
  other: [0.75, 0.75, 0.78],
};

/** PDF annotation subtype for each of our kinds. */
function subtypeOf(kind: AnnotationKind): string {
  switch (kind) {
    case "highlight":
      return "Highlight";
    case "strikeout":
    case "replace":
      return "StrikeOut";
    case "underline":
      return "Underline";
    case "insert":
      return "Caret";
    default:
      return "Text"; // sticky note
  }
}

/** PDF date string, e.g. D:20260809142530Z. */
function pdfDate(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `D:${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`
  );
}

/**
 * Text strings in a PDF must be either PDFDocEncoding or UTF-16BE. Editorial
 * comments routinely contain em dashes and curly quotes, which PDFDocEncoding
 * cannot represent, so anything outside Latin-1 goes out as a hex UTF-16BE
 * string. Getting this wrong turns "don't" into mojibake in Acrobat.
 */
function textString(s: string): PDFString | PDFHexString {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\xFF]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s);
}

/** Side of a sticky-note icon, in points. */
const NOTE_SIZE = 16;

/**
 * A sticky note is an icon at a point, not a region.
 *
 * Giving it the whole paragraph's rect makes it a page-wide box, and — because
 * a note carries no anchored text — re-importing the stamped PDF then recovers
 * its line by measuring from the centre of that box, which lands somewhere
 * else entirely. Observed in the round-trip fixture: a note on line 18 came
 * back on line 14. Pinning it to the start of its first line keeps the icon
 * where a reader expects it and makes the round trip stable.
 */
function noteRect(quads: number[]): [number, number, number, number] {
  const x = quads[0];
  const yTop = quads[1];
  return [x - NOTE_SIZE - 2, yTop - NOTE_SIZE, x - 2, yTop];
}

/** Bounding box of a set of quads, padded a little so nothing is clipped. */
function rectOfQuads(quads: number[], pad = 1): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < quads.length; i += 2) {
    x0 = Math.min(x0, quads[i]);
    x1 = Math.max(x1, quads[i]);
    y0 = Math.min(y0, quads[i + 1]);
    y1 = Math.max(y1, quads[i + 1]);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * Content stream drawing a mark of `kind` over `quads`, in the coordinate space
 * of `rect`. This is the appearance Preview.app needs.
 */
function appearanceOps(
  kind: AnnotationKind,
  quads: number[],
  color: [number, number, number],
  opacity: number
): string {
  const [r, g, b] = color;
  const ops: string[] = ["q"];
  ops.push("/GS0 gs");

  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xL = Math.min(quads[i], quads[i + 4]);
    const xR = Math.max(quads[i + 2], quads[i + 6]);
    const yT = Math.max(quads[i + 1], quads[i + 3]);
    const yB = Math.min(quads[i + 5], quads[i + 7]);
    const h = yT - yB;
    const w = xR - xL;
    if (w <= 0 || h <= 0) continue;

    switch (kind) {
      case "highlight":
        ops.push(`${r} ${g} ${b} rg`, `${xL} ${yB} ${w} ${h} re`, "f");
        break;
      case "strikeout":
      case "replace": {
        const y = yB + h * 0.45;
        ops.push(
          `${r} ${g} ${b} RG`,
          "1.2 w",
          `${xL} ${y} m`,
          `${xR} ${y} l`,
          "S"
        );
        break;
      }
      case "underline": {
        const y = yB + h * 0.08;
        ops.push(
          `${r} ${g} ${b} RG`,
          "1.2 w",
          `${xL} ${y} m`,
          `${xR} ${y} l`,
          "S"
        );
        break;
      }
      case "insert": {
        // A caret: a small filled triangle sitting on the baseline.
        const cx = xL;
        ops.push(
          `${r} ${g} ${b} rg`,
          `${cx - 4} ${yB} m`,
          `${cx + 4} ${yB} l`,
          `${cx} ${yB + 8} l`,
          "f"
        );
        break;
      }
      default: {
        // Sticky note: a rounded-ish filled tag with a border, so it reads as
        // an icon rather than a stray rectangle.
        ops.push(
          `${r} ${g} ${b} rg`,
          "0.25 0.25 0.28 RG",
          "0.7 w",
          `${xL} ${yB} ${Math.min(w, 18)} ${Math.min(h, 16)} re`,
          "B"
        );
        break;
      }
    }
  }
  ops.push("Q");
  void opacity; // opacity is applied via the ExtGState, not the operators
  return ops.join("\n");
}

/** Build the `/AP` normal-appearance form XObject for an annotation. */
function makeAppearance(
  doc: PDFDocument,
  kind: AnnotationKind,
  quads: number[],
  rect: [number, number, number, number],
  color: [number, number, number],
  opacity: number
): PDFRef {
  const ops = appearanceOps(kind, quads, color, opacity);

  // Highlights must multiply so the text underneath stays readable; everything
  // else draws normally with constant alpha.
  const gs = doc.context.obj({
    Type: "ExtGState",
    BM: kind === "highlight" ? "Multiply" : "Normal",
    CA: opacity,
    ca: opacity,
  });

  const stream = PDFRawStream.of(
    doc.context.obj({
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [rect[0], rect[1], rect[2], rect[3]],
      Resources: doc.context.obj({ ExtGState: doc.context.obj({ GS0: gs }) }),
      Length: ops.length,
    }),
    new TextEncoder().encode(ops)
  );
  return doc.context.register(stream);
}

/** The page's `/Annots` array, created if the page has none yet. */
function annotsArray(doc: PDFDocument, pageIndex: number): PDFArray {
  const page = doc.getPage(pageIndex);
  const existing = page.node.lookup(PDFName.of("Annots"));
  if (existing instanceof PDFArray) return existing;
  const arr = doc.context.obj([]) as PDFArray;
  page.node.set(PDFName.of("Annots"), arr);
  return arr;
}

/**
 * Kinds that assert something about *specific words* rather than about a place.
 * Widening one of these to a whole paragraph changes what it says.
 */
function assertsAboutWords(kind: AnnotationKind): boolean {
  return kind === "strikeout" || kind === "replace" || kind === "underline";
}

/**
 * What subtype to actually draw.
 *
 * A strikeout means "delete these words". When the words it covered have been
 * rewritten away, the mark can only be placed on the paragraph — and drawing a
 * strikeout across the whole paragraph tells the editor to delete all of it,
 * which she never asked for. Observed on a real chapter: the editor struck one
 * clause, the author had already cut it, and the re-stamp struck all eleven
 * lines of the paragraph.
 *
 * Degraded word-level marks are therefore drawn as a highlight — "this
 * paragraph is what the note is about" — and {@link contentsFor} says in words
 * what the original mark was.
 */
function drawnKind(item: ReviewItem, degraded: boolean): AnnotationKind {
  return degraded && assertsAboutWords(item.kind) ? "highlight" : item.kind;
}

/** Prefix the editor's comment with status and any loss of precision. */
function contentsFor(item: ReviewItem, degraded: boolean): string {
  const parts: string[] = [];
  if (item.resolved) parts.push("[resolved]");
  if (degraded && assertsAboutWords(item.kind)) {
    const was = (item.markedText || "").replace(/\s+/g, " ").trim();
    parts.push(
      `[${KIND_LABEL[item.kind].toLowerCase()} — the marked text has since been ` +
        `rewritten, so this marks the paragraph` +
        (was ? `; originally: “${was.slice(0, 120)}”` : "") +
        `]`
    );
  }
  if (item.comment) parts.push(item.comment);
  return parts.join(" ");
}

/**
 * Stamp `anchored` into `pdfBytes`, returning the new file.
 *
 * Pure: it neither reads nor writes the filesystem, so the CLI, the extension
 * and the tests all drive the same code.
 */
export async function stampPdf(
  pdfBytes: Uint8Array,
  anchored: AnchoredItem[],
  opts: StampOptions = {}
): Promise<StampResult> {
  const includeResolved = opts.includeResolved ?? true;
  const resolvedOpacity = opts.resolvedOpacity ?? 0.25;
  const fallbackAuthor = opts.replyAuthorFallback ?? "Author";

  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const pageCount = doc.getPageCount();

  let marks = 0;
  let replies = 0;
  let skippedResolved = 0;

  for (const { item, hit, precision } of anchored) {
    if (item.resolved && !includeResolved) {
      skippedResolved++;
      continue;
    }
    const pageIndex = hit.page - 1;
    if (pageIndex < 0 || pageIndex >= pageCount) continue;

    const degraded = precision !== "exact";
    const kind = drawnKind(item, degraded);
    // Keep the original kind's colour so a degraded strikeout still reads as a
    // deletion request at a glance, even though it is drawn as a highlight.
    const color = COLOR[item.kind] ?? COLOR.other;
    // A degraded mark covers a whole paragraph rather than a few words, so a
    // full-strength wash over eleven lines makes the prose hard to read. Fade
    // it: the editor still sees which paragraph, without fighting the text.
    const opacity = item.resolved
      ? resolvedOpacity
      : degraded && assertsAboutWords(item.kind)
        ? 0.35
        : 1;
    const quads = hit.quadPoints.length
      ? hit.quadPoints
      : [hit.rect[0], hit.rect[3], hit.rect[2], hit.rect[3], hit.rect[0], hit.rect[1], hit.rect[2], hit.rect[1]];
    // A note is an icon beside its line; every other kind covers its words.
    const rect =
      subtypeOf(kind) === "Text" ? noteRect(quads) : rectOfQuads(quads);
    const apQuads =
      subtypeOf(kind) === "Text"
        ? [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]
        : quads;
    const ap = makeAppearance(doc, kind, apQuads, rect, color, opacity);

    const sub = subtypeOf(kind);
    const annotDict = doc.context.obj({
      Type: "Annot",
      Subtype: sub,
      Rect: rect,
      // The sidecar item id becomes the PDF's own annotation name. docs/FORMAT.md
      // already says producers should prefer /NM for item ids, so next round's
      // extraction can reattach review state by id instead of guessing from
      // geometry (which a re-render changes) or content fingerprints.
      NM: textString(item.id),
      T: textString(item.author || "Editor"),
      Contents: textString(contentsFor(item, degraded)),
      M: PDFString.of(pdfDate(new Date().toISOString())),
      C: color,
      CA: opacity,
      F: 4, // Print
      AP: doc.context.obj({ N: ap }),
      // QuadPoints is meaningful only for text-markup subtypes; on a sticky
      // note or a caret it is not part of the spec and confuses some readers.
      ...(sub === "Text" || sub === "Caret" ? {} : { QuadPoints: quads }),
    }) as PDFDict;
    const annotRef = doc.context.register(annotDict);
    annotsArray(doc, pageIndex).push(annotRef);
    marks++;

    for (const reply of item.replies ?? []) {
      const replyDict = doc.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [rect[2] - 18, rect[1], rect[2], rect[1] + 18],
        T: textString(reply.author || fallbackAuthor),
        Contents: textString(reply.body),
        M: PDFString.of(pdfDate(reply.createdAt)),
        C: color,
        F: 4,
        // The pair that makes Acrobat render this as a threaded reply rather
        // than a second, unrelated note sitting in the margin.
        IRT: annotRef,
        RT: PDFName.of("R"),
        NM: textString(`${item.id}#${reply.id}`),
      }) as PDFDict;
      annotsArray(doc, pageIndex).push(doc.context.register(replyDict));
      replies++;
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, marks, replies, skippedResolved };
}
