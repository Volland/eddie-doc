/**
 * Make `require("vscode")` resolve to the test stub.
 *
 * The `vscode` module only exists inside the extension host, so any unit test
 * that loads a module importing it would fail at require time. Patching the
 * resolver — rather than sprinkling injection seams through the source — keeps
 * the production code written the way an extension is normally written.
 */
const path = require("node:path");
const Module = require("node:module");

const STUB = path.join(__dirname, "vscode-stub.cjs");
const original = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return original.call(this, request, ...rest);
};
