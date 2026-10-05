// Bundled by esbuild.js as an IIFE and embedded in the plugin as a string
// (`virtual:pdf-worker-source`). Run as a Worker, the worker module starts
// itself; run on the main thread, pdfjs's "fake worker" finds the handler here.
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.min.mjs";

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler };
