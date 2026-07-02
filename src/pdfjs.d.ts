// Minimal typings for the pdfjs legacy build subpath we bundle. We only use a
// small, stable slice of the API, so we declare just that instead of pulling in
// pdfjs's DOM-oriented full type surface.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
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
  }
  export interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
    destroy(): Promise<void>;
  }
  export function getDocument(src: {
    data?: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
    disableFontFace?: boolean;
    verbosity?: number;
  }): { promise: Promise<PdfDocument> };
  export const GlobalWorkerOptions: { workerSrc: string };
  export const version: string;
}
