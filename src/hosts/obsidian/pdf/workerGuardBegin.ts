/**
 * First half of a guard around importing pdfjs's worker module (see engine.ts).
 *
 * That module runs `globalThis.pdfjsWorker = {…}` as soon as it is evaluated. Every
 * plugin and Obsidian itself share one window, and Obsidian's own PDF viewer reads that
 * global to decide whether to use a worker of its own, so leaving ours behind makes the
 * built-in viewer run OUR pdf.js worker code. This records what the global was before.
 */
const g = window as unknown as { pdfjsWorker?: unknown };

export const savedPdfjsWorker = {
  had: Object.prototype.hasOwnProperty.call(g, "pdfjsWorker"),
  value: g.pdfjsWorker,
};
