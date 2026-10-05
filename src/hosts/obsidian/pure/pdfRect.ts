/**
 * The link Obsidian's PDF viewer is opened with to land on an annotation.
 *
 * Obsidian understands `#page=N`. A highlighted rectangle (`&rect=`) is a
 * convention other plugins document; whether the stock viewer honours it, and
 * in which coordinates, is verified on device (see the mobile spike), so the
 * mode is a parameter and the rectangle is always optional: a viewer that
 * ignores it still lands on the right page.
 */

/** `[x0, y0, x1, y1]` in PDF user space: points, origin bottom-left. */
export type PdfRect = [number, number, number, number];

export interface PageGeometry {
  /** Page box `[x0, y0, x1, y1]` in points. */
  view: [number, number, number, number];
}

/**
 * - `pdf-user`: pass the rectangle as the PDF stores it (left, bottom, right, top).
 * - `top-left`: flip to a top-left origin (left, top, right, bottom).
 */
export type RectMode = "pdf-user" | "top-left";

/** Smallest side, in points, worth highlighting. Below it the page link is enough. */
const MIN_SIDE = 0.5;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The `l,b,r,t` rectangle clamped to the page, or null when it is degenerate. */
export function normalizeRect(rect: PdfRect, geometry?: PageGeometry): PdfRect | null {
  let [l, b, r, t] = [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
  if (geometry) {
    const [vx0, vy0, vx1, vy1] = geometry.view;
    l = Math.max(vx0, l);
    b = Math.max(vy0, b);
    r = Math.min(vx1, r);
    t = Math.min(vy1, t);
  }
  if (!(r - l >= MIN_SIDE) || !(t - b >= MIN_SIDE)) return null;
  return [l, b, r, t];
}

// @lat: [[obsidian#PDF preview]]
/** The subpath fragment, e.g. `#page=3&rect=72,700,300,712`. */
export function pdfFragment(
  page: number,
  rect: PdfRect | undefined,
  mode: RectMode = "pdf-user",
  geometry?: PageGeometry
): string {
  const p = Math.max(1, Math.floor(page));
  const n = rect ? normalizeRect(rect, geometry) : null;
  if (!n) return `#page=${p}`;
  if (mode === "top-left" && geometry) {
    const [vx0, , , vy1] = geometry.view;
    const [l, b, r, t] = n;
    return `#page=${p}&rect=${[l - vx0, vy1 - t, r - vx0, vy1 - b].map(fmt).join(",")}`;
  }
  return `#page=${p}&rect=${n.map(fmt).join(",")}`;
}
