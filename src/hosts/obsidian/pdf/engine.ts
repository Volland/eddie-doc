import "../../../core/pdf/polyfill.js"; // must precede the pdfjs import — patches Promise.withResolvers
import * as pdfjs from "pdfjs-dist/build/pdf.min.mjs";
import workerSource from "virtual:pdf-worker-source";
import { setPdfEngine, type PdfEngine } from "../../../core/pdf/engine.js";

export type WorkerMode = "worker" | "main-thread";

export interface EngineOptions {
  /**
   * Run the worker script on the main thread. The default injects a `<script>`
   * from a Blob URL (no `eval`); a test running outside a browser supplies its
   * own.
   */
  loadClassicScript?: (source: string) => Promise<void>;
}

/** Inject `source` as a classic script and resolve once it has run. */
function loadViaScriptTag(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const el = activeDocument.createElement("script");
    el.src = url;
    el.onload = () => {
      el.remove();
      URL.revokeObjectURL(url);
      resolve();
    };
    el.onerror = () => {
      el.remove();
      reject(new Error("could not start the PDF engine on the main thread"));
    };
    activeDocument.head.appendChild(el);
  });
}

let mode: WorkerMode = "worker";
/** Resolves once the engine can parse: immediately for a worker, after the script loads on the main thread. */
let ready: Promise<void> = Promise.resolve();

/** Which way the engine is running; "worker" until a worker is found to fail. */
export function workerMode(): WorkerMode {
  return mode;
}

/**
 * Install pdfjs's browser build as the core's PDF engine.
 *
 * A worker cannot be loaded from a file inside the plugin on mobile, so the
 * worker's source ships inside `main.js` and is started from a Blob URL. If a
 * WebView refuses it — `new Worker` throws, or the worker reports an error — pdfjs
 * runs on the main thread through the same source, and the next `getDocument`
 * waits for that to finish loading. Neither path has been exercised on a phone
 * yet; see docs/obsidian-spike-results.md.
 */
export function useObsidianPdfEngine(opts: EngineOptions = {}): WorkerMode {
  const load = opts.loadClassicScript ?? loadViaScriptTag;
  ready = Promise.resolve();
  mode = "worker";

  const fallBack = () => {
    if (mode === "main-thread") return;
    mode = "main-thread";
    pdfjs.GlobalWorkerOptions.workerPort = null;
    ready = load(workerSource);
    // A failed load is reported to whoever opens a document next (they await it);
    // without this it would also surface as an unhandled rejection here.
    ready.catch(() => undefined);
  };

  try {
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.addEventListener("error", fallBack);
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch {
    fallBack();
  }

  const engine: PdfEngine = {
    getDocument: (src) => ({
      promise: ready.then(() => pdfjs.getDocument(src).promise as ReturnType<PdfEngine["getDocument"]>["promise"]),
    }),
  };
  setPdfEngine(engine);
  return mode;
}

/** The slice of a pdfjs viewport the preview uses. */
export interface PreviewViewport {
  width: number;
  height: number;
  /** `[x0, y0, x1, y1]` in PDF user space → the same rectangle in viewport pixels. */
  convertToViewportRectangle(rect: number[]): number[];
}

export interface PreviewPage {
  getViewport(opts: { scale: number }): PreviewViewport;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PreviewViewport }): {
    promise: Promise<void>;
  };
  cleanup?(): void;
}

/** A PDF opened for drawing pages, as the preview view needs it. */
export interface PreviewDocument {
  numPages: number;
  getPage(n: number): Promise<PreviewPage>;
  destroy(): Promise<void>;
}

/**
 * Open a PDF for rendering. Unlike extraction this needs pdfjs's drawing API, which
 * the core's port deliberately does not expose, so it goes to pdfjs directly — and
 * waits for the main-thread worker if that is the mode in use.
 */
export async function openPreviewDocument(data: Uint8Array): Promise<PreviewDocument> {
  await ready;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdfjs detaches what it is given
    isEvalSupported: false,
    verbosity: 0,
  });
  return (await task.promise) as PreviewDocument;
}
