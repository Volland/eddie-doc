/**
 * The PDF reader the core runs on, injected by the **Host**.
 *
 * Text extraction needs pdfjs, and which pdfjs is a host decision: Node (VS Code
 * extension host, CLI) takes the legacy build with a file worker; Obsidian takes
 * the browser build with an inline worker, because mobile WebViews cannot load a
 * worker from disk. The core states only the slice of pdfjs it uses, and a host
 * hands one over with {@link setPdfEngine} before the first extraction.
 */

export interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e(x), f(y)]
  width: number;
  height: number;
  hasEOL?: boolean;
}

export interface TextContent {
  items: TextItem[];
}

export interface PdfAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[];
  quadPoints?: number[] | number[][] | Float32Array;
  contents?: string;
  contentsObj?: { str?: string };
  title?: string;
  titleObj?: { str?: string };
  inReplyTo?: string;
  parentId?: string;
}

export interface PdfPage {
  getAnnotations(opts?: { intent?: string }): Promise<PdfAnnotation[]>;
  getTextContent(): Promise<TextContent>;
  /** Page box [x0, y0, x1, y1] in PDF points. */
  view?: number[];
  /** Page rotation in degrees (0, 90, 180, 270). */
  rotate?: number;
  /** Release the page's resources; called as pages are finished with. */
  cleanup?(): boolean | void;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

// @lat: [[architecture#Ports#PDF engine]]
export interface PdfEngine {
  getDocument(src: {
    data?: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
    disableFontFace?: boolean;
    verbosity?: number;
  }): { promise: Promise<PdfDocument> };
}

let engine: PdfEngine | undefined;

/** Install the pdfjs a host provides. Calling it again replaces the engine. */
export function setPdfEngine(e: PdfEngine): void {
  engine = e;
}

/** The installed engine; throws a clear error when a host forgot to set one. */
export function pdfEngine(): PdfEngine {
  if (!engine) {
    throw new Error(
      "No PDF engine is installed. The host must call setPdfEngine() before reading a PDF."
    );
  }
  return engine;
}
