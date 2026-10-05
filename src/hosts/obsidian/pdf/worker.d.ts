declare module "virtual:pdf-worker-source" {
  /** The pdfjs worker, bundled as a classic script, as text. */
  const source: string;
  export default source;
}

declare module "pdfjs-dist/build/pdf.min.mjs" {
  export function getDocument(src: unknown): { promise: Promise<unknown> };
  export const GlobalWorkerOptions: { workerSrc: string; workerPort: unknown };
  export const version: string;
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
