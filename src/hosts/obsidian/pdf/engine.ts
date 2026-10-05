import "../../../core/pdf/polyfill.js"; // must precede the pdfjs import — patches Promise.withResolvers
import * as pdfjs from "pdfjs-dist/build/pdf.min.mjs";
// The worker module sets a window global on import; the guard files put it back (see them).
import "./workerGuardBegin.js";
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.min.mjs";
import "./workerGuardEnd.js";
import workerSource from "virtual:pdf-worker-source";
import { setPdfEngine, type PdfEngine } from "../../../core/pdf/engine.js";

export type WorkerMode = "worker" | "main-thread";

let mode: WorkerMode = "worker";

/** Which way the engine is running; "worker" until a worker is found to fail. */
export function workerMode(): WorkerMode {
  return mode;
}

/**
 * Run `fn` — which calls pdfjs's `getDocument` — with the bundled worker code offered
 * to pdfjs's main-thread mode, then take the offer back.
 *
 * pdfjs reads `globalThis.pdfjsWorker` once, synchronously, while it sets up its
 * "fake worker", and keeps what it found. Every plugin and Obsidian itself share one
 * window, and Obsidian's own PDF viewer reads the same global, so it must not be left
 * set (see workerGuardBegin.ts). Setting it only for the duration of this synchronous
 * call means nothing else can observe it. Only used when a real worker is unavailable.
 */
function withMainThreadWorker<T>(fn: () => T): T {
  if (mode !== "main-thread") return fn();
  const g = window as unknown as { pdfjsWorker?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "pdfjsWorker");
  const previous = g.pdfjsWorker;
  g.pdfjsWorker = { WorkerMessageHandler };
  try {
    return fn();
  } finally {
    if (had) g.pdfjsWorker = previous;
    else delete g.pdfjsWorker;
  }
}

/**
 * Install pdfjs's browser build as the core's PDF engine.
 *
 * A worker cannot be loaded from a file inside the plugin on mobile, so the worker's
 * source ships inside `main.js` as text and is started from a Blob URL. If a WebView
 * refuses that — `new Worker` throws, or the worker reports an error — pdfjs runs the
 * same worker code on the main thread instead, from the copy bundled into `main.js`
 * (see {@link withMainThreadWorker}). Nothing is injected into the page: no script
 * element and no `eval`. Neither path has been exercised on every phone; see
 * docs/obsidian-spike-results.md.
 */
export function useObsidianPdfEngine(): WorkerMode {
  mode = "worker";

  const fallBack = () => {
    if (mode === "main-thread") return;
    mode = "main-thread";
    pdfjs.GlobalWorkerOptions.workerPort = null;
  };

  try {
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.addEventListener("error", fallBack);
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch {
    fallBack();
  }

  setPdfEngine({
    getDocument: (src: unknown) => withMainThreadWorker(() => pdfjs.getDocument(src)),
  } as unknown as PdfEngine);
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
  const task = withMainThreadWorker(() =>
    pdfjs.getDocument({
      data: new Uint8Array(data), // pdfjs detaches what it is given
      isEvalSupported: false,
      verbosity: 0,
    })
  );
  return (await task.promise) as PreviewDocument;
}
