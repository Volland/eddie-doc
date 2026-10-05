import "../../core/pdf/polyfill.js"; // must precede the pdfjs import — patches Promise.withResolvers
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { setPdfEngine, type PdfEngine } from "../../core/pdf/engine.js";

/**
 * Install pdfjs's legacy (Node) build as the core's PDF engine.
 *
 * Used by every host that runs in Node: the VS Code extension host and the CLI.
 * `workerFile` is the `pdf.worker.mjs` that esbuild copies next to the bundle —
 * pdfjs would otherwise resolve one relative to the original package layout,
 * which does not exist once bundled.
 */
export function useNodePdfEngine(workerFile: string): void {
  GlobalWorkerOptions.workerSrc = workerFile;
  setPdfEngine({ getDocument } as PdfEngine);
}
