import * as path from "node:path";
import {
  getDocument,
  GlobalWorkerOptions,
  type PdfAnnotation,
  type TextItem,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AnnotationKind, RawAnnotation } from "../model/types.js";

// The bundle runs in Node (CLI + extension host). Point pdfjs at the worker
// file esbuild copied next to this bundle so it doesn't try to resolve one
// relative to the original package layout.
declare const __dirname: string;
GlobalWorkerOptions.workerSrc = path.join(__dirname, "pdf.worker.mjs");

/** Axis-aligned box in PDF user space (bottom-left origin). */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PositionedText {
  str: string;
  box: Box;
}

function subtypeToKind(subtype: string | undefined): AnnotationKind {
  switch ((subtype || "").toLowerCase()) {
    case "highlight":
      return "highlight";
    case "strikeout":
      return "strikeout";
    case "underline":
    case "squiggly":
      return "underline";
    case "text":
    case "freetext":
    case "popup":
      return "comment";
    case "caret":
      return "insert";
    default:
      return "other";
  }
}

/** Normalize pdfjs quadPoints (several shapes across versions) to boxes. */
function quadPointsToBoxes(
  quad: number[] | number[][] | Float32Array | undefined
): Box[] {
  if (!quad) return [];
  // Shape A: array of {x,y}-like pairs already grouped — flatten to numbers.
  let flat: number[];
  if (Array.isArray(quad) && Array.isArray(quad[0])) {
    flat = (quad as number[][]).flat();
  } else {
    flat = Array.from(quad as number[] | Float32Array);
  }
  const boxes: Box[] = [];
  // 8 numbers per quad: 4 (x,y) points.
  for (let i = 0; i + 7 < flat.length; i += 8) {
    const xs = [flat[i], flat[i + 2], flat[i + 4], flat[i + 6]];
    const ys = [flat[i + 1], flat[i + 3], flat[i + 5], flat[i + 7]];
    boxes.push({
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    });
  }
  return boxes;
}

function rectToBox(rect: number[] | undefined): Box | null {
  if (!rect || rect.length < 4) return null;
  return {
    x0: Math.min(rect[0], rect[2]),
    y0: Math.min(rect[1], rect[3]),
    x1: Math.max(rect[0], rect[2]),
    y1: Math.max(rect[1], rect[3]),
  };
}

function itemBox(item: TextItem): Box | null {
  const t = item.transform;
  if (!t || t.length < 6) return null;
  const x = t[4];
  const y = t[5];
  const w = item.width || 0;
  const h = item.height || Math.hypot(t[1], t[3]) || 10;
  // Baseline sits near y; give the glyph box a little vertical body.
  return { x0: x, y0: y - h * 0.25, x1: x + w, y1: y + h * 0.85 };
}

/**
 * Does a text item fall under a markup quad? Markup quads are per-line bands, so
 * we test whether the item shares the quad's vertical band and its horizontal
 * span intersects the quad at all. This intentionally over-captures a full line
 * when only part of it is marked — extra same-line words still fuzzy-match to
 * the right source line, whereas dropping partially-covered items loses the line
 * entirely (asciidoctor-pdf emits near-full-line text runs).
 */
function underQuad(item: Box, quad: Box): boolean {
  const cy = (item.y0 + item.y1) / 2;
  const inBand = cy >= quad.y0 - 2 && cy <= quad.y1 + 2;
  if (!inBand) return false;
  const ix = Math.min(item.x1, quad.x1) - Math.max(item.x0, quad.x0);
  return ix > 0;
}

/** Collect text under a set of markup boxes, in reading order. */
function textUnder(boxes: Box[], texts: PositionedText[]): string {
  if (boxes.length === 0) return "";
  const hit = texts.filter((t) => boxes.some((b) => underQuad(t.box, b)));
  return orderAndJoin(hit);
}

/**
 * Clip a text run to the horizontal span of a quad. PDF generators (incl.
 * asciidoctor-pdf) emit text in whole-line runs, so item-level selection can't
 * isolate a few marked words. We estimate per-character x-positions from the
 * run's width (proportional-font approximation) to find the marked slice, then
 * snap to whole words — editors mark word ranges, so snapping cancels the
 * approximation error at the boundaries.
 */
function clipRunToQuad(item: PositionedText, quad: Box): string {
  const s = item.str;
  const n = s.length;
  if (n === 0) return "";
  const cw = (item.box.x1 - item.box.x0) / n;
  if (cw <= 0) return "";

  const inside = (k: number) => {
    const cx = item.box.x0 + (k + 0.5) * cw;
    return cx >= quad.x0 && cx <= quad.x1;
  };
  // Include a whole word only when the MAJORITY of its characters fall inside
  // the quad — a boundary sliver (one char of the next word nicked by the
  // proportional-width estimate) doesn't drag the whole word in.
  const isWord = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  const words: string[] = [];
  let k = 0;
  while (k < n) {
    if (!isWord(s[k])) {
      k++;
      continue;
    }
    let j = k;
    let hits = 0;
    while (j < n && isWord(s[j])) {
      if (inside(j)) hits++;
      j++;
    }
    // Include a whole word only when the majority of its characters fall inside
    // the quad. Punctuation is dropped — `locate` matches on words, and the
    // deletion range comes from the source text, so only the word order matters.
    if (hits / (j - k) > 0.5) words.push(s.slice(k, j));
    k = j;
  }
  return words.join(" ");
}

/**
 * Tighter version of {@link textUnder} that yields only the words actually
 * inside the markup quads (see {@link clipRunToQuad}). Used for
 * character-level edits.
 */
function preciseTextUnder(boxes: Box[], texts: PositionedText[]): string {
  if (boxes.length === 0) return "";
  const pieces: PositionedText[] = [];
  for (const t of texts) {
    const cy = (t.box.y0 + t.box.y1) / 2;
    for (const b of boxes) {
      if (cy < b.y0 - 2 || cy > b.y1 + 2) continue;
      const clipped = clipRunToQuad(t, b);
      if (clipped.trim()) pieces.push({ str: clipped, box: t.box });
      break;
    }
  }
  return orderAndJoin(pieces);
}

/** Text on the caret's line lying to its left, for precise insertion. */
function textBefore(point: Box, texts: PositionedText[]): string {
  const cy = (point.y0 + point.y1) / 2;
  const cx = (point.x0 + point.x1) / 2;
  const line = texts.filter((t) => {
    const ty = (t.box.y0 + t.box.y1) / 2;
    return Math.abs(ty - cy) <= 4 && (t.box.x0 + t.box.x1) / 2 < cx;
  });
  return orderAndJoin(line);
}

/** Nearest text to a point annotation (sticky notes have no anchored text). */
function nearestText(box: Box, texts: PositionedText[]): string {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let best: PositionedText | null = null;
  let bestD = Infinity;
  for (const t of texts) {
    const tx = (t.box.x0 + t.box.x1) / 2;
    const ty = (t.box.y0 + t.box.y1) / 2;
    const d = Math.hypot(tx - cx, ty - cy);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  if (!best) return "";
  // Grab the whole line the nearest item sits on for better matching.
  const lineY = (best.box.y0 + best.box.y1) / 2;
  const line = texts.filter(
    (t) => Math.abs((t.box.y0 + t.box.y1) / 2 - lineY) <= 3
  );
  return orderAndJoin(line);
}

function orderAndJoin(items: PositionedText[]): string {
  const sorted = [...items].sort((a, b) => {
    const dy = b.box.y1 - a.box.y1; // top-to-bottom (higher y first)
    if (Math.abs(dy) > 4) return dy;
    return a.box.x0 - b.box.x0; // left-to-right
  });
  return sorted
    .map((t) => t.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function annComment(a: PdfAnnotation): string {
  return (a.contentsObj?.str || a.contents || "").trim();
}

function annAuthor(a: PdfAnnotation): string | undefined {
  return (a.titleObj?.str || a.title || "").trim() || undefined;
}

function stableId(kind: string, page: number, box: Box): string {
  return `p${page}-${kind}-${Math.round(box.x0)}-${Math.round(box.y0)}`;
}

/**
 * Extract review-relevant annotations from a PDF buffer, recovering the text
 * physically under each markup so it can later be matched to AsciiDoc source.
 */
export async function extractAnnotations(
  data: Uint8Array
): Promise<RawAnnotation[]> {
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const out: RawAnnotation[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [annots, content] = await Promise.all([
        page.getAnnotations({ intent: "display" }),
        page.getTextContent(),
      ]);

      const texts: PositionedText[] = [];
      for (const it of content.items) {
        if (!("str" in it) || !it.str.trim()) continue;
        const box = itemBox(it as TextItem);
        if (box) texts.push({ str: it.str, box });
      }

      for (const a of annots) {
        const kind = subtypeToKind(a.subtype);
        // Popups are containers for another annotation's comment; skip them.
        if ((a.subtype || "").toLowerCase() === "popup") continue;
        // Skip reply annotations that only echo a thread.
        if (a.inReplyTo) continue;

        const rectBox = rectToBox(a.rect);
        const quadBoxes = quadPointsToBoxes(a.quadPoints);
        const geomBox =
          quadBoxes.length > 0
            ? {
                x0: Math.min(...quadBoxes.map((b) => b.x0)),
                y0: Math.min(...quadBoxes.map((b) => b.y0)),
                x1: Math.max(...quadBoxes.map((b) => b.x1)),
                y1: Math.max(...quadBoxes.map((b) => b.y1)),
              }
            : rectBox;
        if (!geomBox) continue;

        let anchored = "";
        let marked: string | undefined;
        let before: string | undefined;
        const markBoxes = quadBoxes.length
          ? quadBoxes
          : rectBox
            ? [rectBox]
            : [];
        if (kind === "highlight" || kind === "strikeout" || kind === "underline") {
          anchored = textUnder(markBoxes, texts);
          marked = preciseTextUnder(markBoxes, texts) || undefined;
        } else if (kind === "comment" || kind === "insert" || kind === "other") {
          anchored = nearestText(geomBox, texts);
          if (kind === "insert") before = textBefore(geomBox, texts) || undefined;
        }

        const comment = annComment(a);
        // Drop empty markup with neither anchored text nor a comment.
        if (!anchored && !comment) continue;

        out.push({
          id: stableId(kind, p, geomBox),
          kind,
          page: p,
          comment,
          anchoredText: anchored,
          markedText: marked,
          beforeText: before,
          author: annAuthor(a),
          rect: [geomBox.x0, geomBox.y0, geomBox.x1, geomBox.y1],
        });
      }
    }
  } finally {
    await doc.destroy();
  }

  // Deduplicate ids (Acrobat sometimes emits paired markup+popup at same spot).
  const seen = new Set<string>();
  return out.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
