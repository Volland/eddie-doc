import { pdfEngine } from "./engine.js";

/** A page's box and rotation, as the PDF declares them. */
export interface PageGeometry {
  /** `[x0, y0, x1, y1]` in points, PDF user space. */
  view: [number, number, number, number];
  /** Degrees clockwise: 0, 90, 180 or 270. */
  rotate: number;
}

/**
 * Read one page's geometry. The sidecar stores an annotation's rectangle in
 * unrotated PDF user space but not the page box or rotation, and a viewer link
 * needs the box to clamp or flip it, so it is read from the PDF when needed.
 * Returns undefined when the page does not exist or the PDF cannot be read.
 */
export async function readPageGeometry(
  data: Uint8Array,
  page: number
): Promise<PageGeometry | undefined> {
  let doc;
  try {
    doc = await pdfEngine().getDocument({
      data: new Uint8Array(data), // pdfjs detaches what it is given
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch {
    return undefined;
  }
  try {
    if (page < 1 || page > doc.numPages) return undefined;
    const p = await doc.getPage(page);
    const v = p.view;
    if (!v || v.length < 4) return undefined;
    const rotate = (((p.rotate ?? 0) % 360) + 360) % 360;
    return { view: [v[0], v[1], v[2], v[3]], rotate };
  } finally {
    await doc.destroy();
  }
}
