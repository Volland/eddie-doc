#!/usr/bin/env node
/**
 * Load the built Obsidian plugin (dist/obsidian/main.js) against a stub of the
 * `obsidian` module and a strict in-memory vault, and drive it end to end:
 * onload, command registration, then map the sample PDF through the real
 * ObsidianStorage, restart, and confirm the review comes back.
 *
 * What this proves: the bundle evaluates, onload wires up, and the storage
 * adapter honours the contract Obsidian's does (writes fail into folders that do
 * not exist; `list` returns full paths). What it cannot prove is anything about
 * real Obsidian — views, the PDF viewer, mobile. See docs/obsidian-qa.md.
 */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const bundle = path.join(root, "dist/obsidian/main.js");
if (!fs.existsSync(bundle)) {
  console.error("build first: npm run build");
  process.exit(1);
}

// -- a strict vault -----------------------------------------------------------
class Adapter {
  constructor() { this.files = new Map(); this.dirs = new Set([""]); }
  enc(t) { return new TextEncoder().encode(t); }
  parent(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  need(p) { if (!this.dirs.has(this.parent(p))) throw new Error(`ENOENT: parent of ${p} does not exist`); }
  async exists(p) { return this.files.has(p) || this.dirs.has(p); }
  async read(p) { if (!this.files.has(p)) throw new Error("ENOENT " + p); return new TextDecoder().decode(this.files.get(p)); }
  async readBinary(p) { if (!this.files.has(p)) throw new Error("ENOENT " + p); const b = this.files.get(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async write(p, t) { this.need(p); this.files.set(p, this.enc(t)); }
  async writeBinary(p, buf) { this.need(p); this.files.set(p, new Uint8Array(buf.slice(0))); }
  async mkdir(p) { this.need(p); this.dirs.add(p); }
  async remove(p) { this.files.delete(p); }
  async list(d) {
    const files = [], folders = [];
    for (const f of this.files.keys()) if (this.parent(f) === d) files.push(f);
    for (const x of this.dirs) if (x && this.parent(x) === d) folders.push(x);
    return { files, folders };
  }
}

const adapter = new Adapter();
const handlers = {}; // vault event name -> callbacks, in registration order
const registered = { commands: [], views: [], tabs: 0, extensions: [], events: [] };
class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.name = p.split("/").pop(); this.stat = { mtime: 0 }; } }
class TFolder { constructor(p) { this.path = p; this.name = p.split("/").pop(); } }
class TAbstractFile {}
const vaultFiles = () => [...adapter.files.keys()].map((p) => new TFile(p));

const app = {
  vault: {
    adapter,
    // The index follows the disk, as it does once Obsidian has caught up. Files in a
    // dot-folder are never indexed (Obsidian skips them), so those use the adapter path.
    getAbstractFileByPath: (p) => {
      if (p.split("/").some((s) => s.startsWith("."))) return null;
      if (adapter.files.has(p)) return new TFile(p);
      if (p && adapter.dirs.has(p)) return new TFolder(p);
      return null;
    },
    // Faithful errors: creating something that exists fails, as Obsidian's does.
    create: async (p, t) => { if (adapter.files.has(p)) throw new Error("File already exists."); await adapter.write(p, t); return new TFile(p); },
    createBinary: async (p, b) => { if (adapter.files.has(p)) throw new Error("File already exists."); await adapter.writeBinary(p, b); return new TFile(p); },
    createFolder: async (p) => { if (adapter.dirs.has(p)) throw new Error("Folder already exists."); await adapter.mkdir(p); },
    process: async (f, fn) => { const next = fn(await adapter.read(f.path)); await adapter.write(f.path, next); return next; },
    modifyBinary: async (f, b) => adapter.writeBinary(f.path, b),
    read: async (f) => adapter.read(f.path),
    readBinary: async (f) => adapter.readBinary(f.path),
    getFiles: vaultFiles,
    on: (name, cb) => { (handlers[name] ||= []).push(cb); return {}; },
  },
  fileManager: { trashFile: async (f) => adapter.remove(f.path) },
  workspace: {
    onLayoutReady: (cb) => cb(),
    on: (name) => { registered.events.push(name); return {}; },
    getActiveViewOfType: () => null,
    getMostRecentLeaf: () => null,
    getLeavesOfType: () => [],
    iterateAllLeaves: () => {},
    getRightLeaf: () => ({ setViewState: async () => {} }),
    revealLeaf: async () => {},
  },
  viewRegistry: { typeByExtension: {} },
};

class Plugin {
  constructor() { this.app = app; this.manifest = { dir: ".obsidian/plugins/eddie-doc" }; this._data = null; }
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
  registerView(t) { registered.views.push(t); }
  addSettingTab() { registered.tabs++; }
  addRibbonIcon() {}
  addCommand(c) { registered.commands.push(c.id); }
  registerEditorExtension() {}
  registerExtensions(exts) { registered.extensions.push(...exts); }
  registerEvent() {}
  register() {}
  addStatusBarItem() { return { addClass() {}, addEventListener() {}, setText() {} }; }
}
const stubClass = class {};
const stub = {
  Plugin, ItemView: stubClass, Modal: stubClass, FuzzySuggestModal: stubClass, PluginSettingTab: stubClass,
  Setting: stubClass, Menu: stubClass, MarkdownView: stubClass, MarkdownRenderer: { render: async () => {} },
  Notice: class { constructor(m) { (stub.notices ||= []).push(m); } hide() {} },
  TFile, TFolder, TAbstractFile, Platform: { isMobile: false, isDesktopApp: true },
  normalizePath: (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
  editorInfoField: { id: "info" },
  requestUrl: async () => ({ status: 200, json: {} }),
};

const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "obsidian") return "obsidian";
  return orig.call(this, req, ...rest);
};
require.cache["obsidian"] = { id: "obsidian", filename: "obsidian", loaded: true, exports: stub };

// CodeMirror is external in the bundle (Obsidian provides it); here the repo's copy stands in.
// A browser-less stand-in for the one DOM thing the PDF engine needs: loading its
// worker script on the main thread (there is no Worker here, so it falls back).
let lastBlob;
URL.createObjectURL = (blob) => { lastBlob = blob; return "blob:smoke"; };
URL.revokeObjectURL = () => {};

const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

(async () => {
  globalThis.window = globalThis; // Obsidian always has one; the bundle reads it at load
  const mod = require(bundle);
  // Installed after the bundle (and CodeMirror) have loaded: CodeMirror inspects `document` on import.
  globalThis.activeDocument = globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: { appendChild(el) { const b = lastBlob; b.text().then((src) => { (0, eval)(src); el.onload(); }, () => el.onerror()); } },
  };
  const Eddie = mod.default;
  check(typeof Eddie === "function", "bundle has a default-exported plugin class");

  // vault content: the sample manuscript and annotated PDF
  await adapter.mkdir("Manuscript"); await adapter.mkdir("Inbox");
  await adapter.write("Manuscript/chapter-01.adoc", fs.readFileSync(path.join(root, "sample/chapter-01.adoc"), "utf8"));
  await adapter.writeBinary("Inbox/chapter-01.annotated.pdf", fs.readFileSync(path.join(root, "sample/chapter-01.annotated.pdf")));

  const boot = async (data) => {
    const p = new Eddie();
    p._data = data;
    await p.onload();
    return p;
  };

  const p1 = await boot(null);
  check(registered.views.includes("eddie-review"), "review view registered");
  check(registered.tabs === 1, "settings tab registered");
  check(registered.commands.length >= 30, `commands registered (${registered.commands.length})`);
  for (const id of ["open-review", "stamp-pdf", "export-report", "triage-unmatched", "apply-all-edits"]) {
    check(registered.commands.includes(id), "command " + id);
  }
  check(registered.extensions.join() === "adoc,asciidoc", "claimed .adoc and .asciidoc when nobody holds them: " + registered.extensions);
  check(p1.settings.reviewFolder === "Eddie Reviews" && p1.settings.importPdfs === true, "Obsidian defaults");
  check(p1.host.capabilities.semanticFallback === true, "desktop can reach localhost");

  // map the sample PDF using only vault-relative paths, through the real storage adapter
  const session = await p1.store.loadReview("Manuscript/chapter-01.adoc", "Inbox/chapter-01.annotated.pdf", {
    threshold: 0.5, revision: { id: "rev-1", ordinal: 1 }, importPdf: true,
  });
  await p1.store.flush();
  check(session.items.length === 5, "5 annotations extracted (got " + session.items.length + ")");
  check(session.sidecarPath === "Eddie Reviews/Manuscript/chapter-01/rev-1/chapter-01.review.json", "sidecar path " + session.sidecarPath);
  check(await adapter.exists("Eddie Reviews/Manuscript/chapter-01/rev-1/pdf/chapter-01.pdf"), "PDF copied into the round");
  const first = session.items[0].id;
  p1.store.toggleResolved("Manuscript/chapter-01.adoc", first);
  await p1.onunload(); // flushes the queued save

  // "restart Obsidian": a fresh plugin instance over the same vault
  const p2 = await boot(p1._data);
  await p2.store.tryLoadSidecar("Manuscript/chapter-01.adoc");
  const again = p2.store.get("Manuscript/chapter-01.adoc");
  check(again && again.items.length === 5, "review reloads from the vault");
  check(p2.store.findItem("Manuscript/chapter-01.adoc", first).resolved === true, "resolved state survived the restart");

  // the user renames the manuscript in the file explorer: the review follows it
  const renameHandler = handlers.rename[handlers.rename.length - 1];
  await adapter.write("Manuscript/ch1.adoc", await adapter.read("Manuscript/chapter-01.adoc"));
  await adapter.remove("Manuscript/chapter-01.adoc");
  renameHandler(new TFile("Manuscript/ch1.adoc"), "Manuscript/chapter-01.adoc");
  await new Promise((r) => setTimeout(r, 30));
  check(p2.store.get("Manuscript/ch1.adoc"), "review follows a renamed manuscript");
  check(!p2.store.get("Manuscript/chapter-01.adoc"), "and is no longer under the old name");
  await p2.store.flush();
  const side = await adapter.read(session.sidecarPath);
  check(side.includes("ch1.adoc") && !side.includes("chapter-01.adoc"), "the sidecar's recorded source path was rewritten");

  // an unrelated rename leaves the settings alone…
  const rename = () => handlers.rename[handlers.rename.length - 1];
  rename()(new TFile("Other/b.txt"), "Other/a.txt");
  await new Promise((r) => setTimeout(r, 20));
  check(p2.settings.reviewFolder === "Eddie Reviews", "an unrelated rename leaves the review folder setting alone");

  // …but renaming the review folder itself is followed, or new mappings would go to the old name
  rename()(new TFile("Reviews2"), "Eddie Reviews");
  await new Promise((r) => setTimeout(r, 30));
  check(p2.settings.reviewFolder === "Reviews2", "the review folder setting follows a renamed folder");
  check(p2.store.get("Manuscript/ch1.adoc").sidecarPath.startsWith("Reviews2/"), "and so do the loaded mappings");

  // another plugin already owns .adoc: do not take it
  registered.extensions.length = 0;
  app.viewRegistry.typeByExtension = { adoc: "asciidoc-live-view" };
  const p3 = await boot(p1._data);
  check(registered.extensions.join() === "asciidoc", "left .adoc to the plugin that holds it, claimed only .asciidoc: " + registered.extensions);
  check(p3.heldByOthers.join() === "adoc", "remembers who it left alone");
  await p3.onunload();

  console.log(`obsidian smoke: ok (${new Set(registered.commands).size} commands, ${session.items.length} annotations, reload, claim)`);
})().catch((e) => { console.error(e); process.exit(1); });
