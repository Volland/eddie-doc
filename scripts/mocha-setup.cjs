/**
 * Mocha preload: install the Node PDF engine the core's extraction runs on.
 *
 * The core never imports pdfjs itself (see `src/core/pdf/engine.ts`); each host
 * hands it one. Tests act as a Node host, pointing pdfjs at its own worker file
 * in node_modules instead of the one esbuild copies beside a bundle.
 */
const path = require("node:path");

const { useNodePdfEngine } = require("../out/hosts/node/pdfEngine.js");
useNodePdfEngine(
  path.join(__dirname, "..", "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
);

// Host modules that import `obsidian` load against a minimal stub (see the file).
const Module = require("node:module");
const STUB = path.join(__dirname, "obsidian-stub.cjs");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "obsidian") return STUB;
  return original.call(this, request, ...rest);
};
