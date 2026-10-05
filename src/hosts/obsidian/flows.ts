/**
 * Everything a user can do, as plain async functions over the plugin.
 *
 * The review panel's buttons and the command palette call the same functions, so
 * a button and its command cannot drift apart. Each flow mirrors the VS Code
 * command of the same name, with Obsidian's surfaces swapped in: a fuzzy modal
 * for a quick-pick, a notice for a progress toast, an editor transaction for a
 * workspace edit.
 */
import { MarkdownView, Notice, Platform, TFile } from "obsidian";
import type EddiePlugin from "./main.js";
import { choose, confirm, prompt } from "./ui/modals.js";
import { pdfFragment, type PdfRect } from "./pure/pdfRect.js";
import { isCancelled, type Progress } from "../../core/host/progress.js";
import { readPageGeometry } from "../../core/pdf/pageGeometry.js";
import { effectiveLine, isConfident } from "../../core/matching/mapper.js";
import { buildSourceIndex, topMatches } from "../../core/matching/fuzzyMatch.js";
import { extractAnnotations, readPages } from "../../core/pdf/extract.js";
import { anchorItems } from "../../core/pdf/anchor.js";
import { stampPdf } from "../../core/pdf/stamp.js";
import { annotationsToAdoc, extractedAdocPath } from "../../core/pdf/toAdoc.js";
import { renderReport, isSessionStale } from "../../core/model/report.js";
import { stripMarkers } from "../../core/source/markers.js";
import { resolveSourcePath } from "../../core/model/format.js";
import {
  documentFolder,
  legacySourceCandidates,
  mappingReportPath,
  pdfFolder,
} from "../../core/model/layout.js";
import {
  KIND_LABEL,
  PDF_ROLE_LABEL,
  mappingLabel,
  revisionLabel,
  type MappingInfo,
  type ReviewItem,
  type ReviewSession,
  type RevisionInfo,
} from "../../core/model/types.js";
import {
  applyEdits,
  overlaps,
  parseSuggestion,
  planAllConfident,
  planDeleteLines,
  planDeleteStruck,
  planInsertAtMark,
  planInsertNote,
  planReplaceMarked,
  type EditAction,
  type TextEdit,
} from "../../core/edits/plan.js";
import * as path from "../../core/util/path.js";
import { isAdocPath } from "../../core/util/adoc.js";
import { itemSpan } from "../../core/view/annotationView.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

export type OpenMode = "ask" | "new" | "current";

interface ItemRef {
  adocPath: string;
  id: string;
}

// -- small helpers ------------------------------------------------------------------

function notify(plugin: EddiePlugin, message: string): void {
  void plugin.host.notify.info(message);
}

/**
 * A long-running, cancellable operation: a notice that shows per-page progress and
 * cancels when clicked (or through the "Cancel the running operation" command).
 * Pass `progress` to the core call; call `done()` when finished.
 */
function startOp(plugin: EddiePlugin, message: string): { progress: Progress; done(): void } {
  const ctl = plugin.beginOp();
  const n = new Notice(`${message} (click to cancel)`, 0);
  n.noticeEl.addEventListener("click", () => ctl.abort());
  return {
    progress: {
      signal: ctl.signal,
      report: (d, t, l) => n.setMessage(`${message} ${l ?? "step"} ${d}/${t} (click to cancel)`),
    },
    done: () => {
      n.hide();
      plugin.endOp(ctl);
    },
  };
}

/** Say so quietly when the user cancelled; otherwise report the failure. */
function failed(plugin: EddiePlugin, what: string, e: unknown): void {
  if (isCancelled(e)) notify(plugin, `Eddie Doc: ${what} cancelled.`);
  else plugin.host.notify.warn(`Eddie Doc: ${what} failed — ${String(e)}`);
}

function stamp(): string {
  return new Date().toISOString();
}

/** The annotation a command acts on: the panel's selection, else the one under the cursor. */
export function currentItem(plugin: EddiePlugin): ItemRef | undefined {
  const sel = plugin.selection;
  if (sel && plugin.store.findItem(sel.adocPath, sel.id)) return sel;
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file;
  if (!view || !file || !isAdocPath(file.path)) return undefined;
  const session = plugin.store.get(file.path);
  if (!session) return undefined;
  const line = view.editor.getCursor().line;
  const hit = session.items.find((i) => {
    const s = itemSpan(i);
    return s && line >= s.start && line <= s.end;
  });
  return hit ? { adocPath: file.path, id: hit.id } : undefined;
}

function needItem(plugin: EddiePlugin): ItemRef | undefined {
  const ref = currentItem(plugin);
  if (!ref) notify(plugin, "Eddie Doc: select an annotation in the review panel first.");
  return ref;
}

function needSession(plugin: EddiePlugin): { adocPath: string; session: ReviewSession } | undefined {
  const adocPath = plugin.resolvedAdoc();
  const session = adocPath ? plugin.store.get(adocPath) : undefined;
  if (!adocPath || !session) {
    notify(plugin, "Eddie Doc: open a document with a loaded review first.");
    return undefined;
  }
  return { adocPath, session };
}

/** Where a generated file belongs: in the mapping's round folder, or beside `fallback`. */
function outputPath(
  plugin: EddiePlugin,
  session: ReviewSession,
  setting: "stampOutput" | "reportOutput",
  fallback: string,
  kind: "pdf" | "report"
): string {
  if (plugin.settings[setting] !== "reviewFolder") return fallback;
  const folder = documentFolder(plugin.store.layoutConfig, session.adocPath);
  if (!folder) return fallback;
  if (kind === "report") return mappingReportPath(folder, session.revision.id, session.mapping.id);
  return path.join(pdfFolder(folder, session.revision.id), path.basename(fallback));
}

// -- loading ------------------------------------------------------------------------

/** Walk `dir` for files satisfying `keep`, to a bounded depth. */
async function walk(plugin: EddiePlugin, dir: string, keep: (name: string) => boolean, depth = 6): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of await plugin.host.storage.list(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(plugin, p, keep, depth - 1)));
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

/**
 * Load every mapping the vault knows about: everything under the review folder,
 * plus legacy sidecars that sit beside their manuscript.
 */
export async function loadReviewFolder(plugin: EddiePlugin): Promise<void> {
  const { storage } = plugin.host;
  const folder = plugin.settings.reviewFolder;
  const found = new Set<string>(await walk(plugin, folder, (n) => /\.review\.json$/i.test(n)));
  for (const f of plugin.app.vault.getFiles()) {
    if (/\.review\.json$/i.test(f.path) && !path.normalize(f.path).startsWith(path.normalize(folder) + "/")) {
      found.add(f.path);
    }
  }
  for (const file of [...found].sort()) {
    if (plugin.store.getBySidecar(file)) continue;
    let adoc: string | undefined;
    try {
      adoc = resolveSourcePath(await storage.readText(file), file);
    } catch {
      continue;
    }
    if (!adoc || !isAdocPath(adoc) || !(await storage.exists(adoc))) {
      for (const c of legacySourceCandidates(file)) {
        if (isAdocPath(c) && (await storage.exists(c))) {
          adoc = c;
          break;
        }
      }
    }
    if (adoc && (await storage.exists(adoc))) await plugin.store.loadSidecarFile(file, adoc);
  }
}

// -- choosing files -------------------------------------------------------------------

/** A PDF from the vault, newest first; on desktop also one picked from disk and copied in. */
export async function pickPdf(plugin: EddiePlugin, placeholder: string): Promise<string | undefined> {
  const DISK = "Choose a file from disk…";
  const files = plugin.app.vault
    .getFiles()
    .filter((f) => f.extension.toLowerCase() === "pdf")
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .map((f) => f.path);
  const items = Platform.isDesktopApp ? [...files, DISK] : files;
  if (!items.length) {
    notify(plugin, "Eddie Doc: no PDF in the vault. Put the annotated PDF in your vault first.");
    return undefined;
  }
  const picked = await choose(plugin.app, items, (p) => p, placeholder);
  if (picked === DISK) return importFromDisk(plugin);
  return picked;
}

/** Desktop only: copy a PDF from outside the vault into it, then offer to map it. */
export async function importPdfFromDisk(plugin: EddiePlugin): Promise<void> {
  const target = await importFromDisk(plugin);
  if (target) await openReview(plugin, "ask", target);
}

/** Stop the running extraction at its next page. */
export function cancelOperation(plugin: EddiePlugin): void {
  if (plugin.currentOp) plugin.currentOp.abort();
  else notify(plugin, "Eddie Doc: nothing is running.");
}

/** Desktop only: read a PDF from anywhere and copy it into the vault. */
async function importFromDisk(plugin: EddiePlugin): Promise<string | undefined> {
  const file = await new Promise<File | undefined>((resolve) => {
    const input = activeDocument.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.addEventListener("change", () => resolve(input.files?.[0]));
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
  if (!file) return undefined;
  const target = path.join(plugin.settings.reviewFolder, "_imported", file.name);
  await plugin.host.storage.writeBytes(target, new Uint8Array(await file.arrayBuffer()));
  notify(plugin, `Eddie Doc: copied ${file.name} into ${path.dirname(target)}.`);
  return target;
}

/** `foo.pdf` / `foo.annotated.pdf` → `foo.adoc` beside it, if there is one. */
async function siblingAdoc(plugin: EddiePlugin, pdfPath: string): Promise<string | undefined> {
  const base = pdfPath.replace(/(\.annotated)?\.pdf$/i, "");
  for (const ext of [".adoc", ".asciidoc"]) {
    if (await plugin.host.storage.exists(base + ext)) return base + ext;
  }
  return undefined;
}

async function pickAdoc(plugin: EddiePlugin, pdfPath: string): Promise<string | undefined> {
  const active = plugin.resolvedAdoc();
  const sibling = await siblingAdoc(plugin, pdfPath);
  const all = plugin.app.vault
    .getFiles()
    .filter((f) => isAdocPath(f.path))
    .map((f) => f.path);
  if (!all.length) {
    notify(plugin, "Eddie Doc: no .adoc file in the vault to map the PDF onto.");
    return undefined;
  }
  const preferred = [sibling, active].filter((p): p is string => !!p);
  const ordered = [...new Set([...preferred, ...all])];
  if (sibling && all.includes(sibling) && sibling === active) return sibling;
  return choose(plugin.app, ordered, (p) => p, `Which source does ${path.basename(pdfPath)} belong to?`);
}

// -- mapping PDFs ---------------------------------------------------------------------

interface RevisionChoice {
  revision: RevisionInfo;
  appendTo?: string;
}

async function chooseRevision(
  plugin: EddiePlugin,
  adocPath: string,
  mode: OpenMode,
  existing: ReviewSession[]
): Promise<RevisionChoice | undefined> {
  const { store } = plugin;
  if (!existing.length || mode === "new") return { revision: store.nextRevision(adocPath) };
  if (mode === "current") {
    return { revision: store.latestRevision(adocPath) ?? store.nextRevision(adocPath) };
  }
  const next = store.nextRevision(adocPath);
  const options: { label: string; choice: RevisionChoice }[] = [
    { label: `Start ${revisionLabel(next)} — a new round, carrying resolved state forward`, choice: { revision: next } },
  ];
  for (const rev of store.revisionsFor(adocPath).slice().reverse()) {
    const inRound = existing.filter((s) => s.revision.id === rev.id);
    options.push({
      label: `${revisionLabel(rev)} — a separate mapping beside ${inRound.map(mappingLabel).join(", ")}`,
      choice: { revision: rev },
    });
    for (const s of inRound) {
      options.push({
        label: `Add to ${mappingLabel(s)} (${s.items.length} marks) — one numbered list`,
        choice: { revision: rev, appendTo: s.sidecarPath },
      });
    }
  }
  const picked = await choose(plugin.app, options, (o) => o.label, "Which round do these marks belong to?");
  return picked?.choice;
}

async function promptMappingMeta(
  plugin: EddiePlugin,
  pdfPath: string,
  current?: MappingInfo
): Promise<Partial<MappingInfo>> {
  const origin = await prompt(plugin.app, "Whose marks are these?", {
    detail: `${path.basename(pdfPath)} — an editor or site name, e.g. “Acme Editorial”. Leave empty to skip.`,
    value: current?.origin ?? "",
  });
  return origin?.trim() ? { origin: origin.trim() } : {};
}

export async function openReview(plugin: EddiePlugin, mode: OpenMode, preselected?: string): Promise<void> {
  const pdfPath = preselected ?? (await pickPdf(plugin, "Select the annotated PDF to map"));
  if (!pdfPath) return;
  const adocPath = await pickAdoc(plugin, pdfPath);
  if (!adocPath) return;
  const { store } = plugin;

  await plugin.saveSource(adocPath);
  await store.tryLoadSidecar(adocPath);
  const existing = store.sessionsFor(adocPath);
  const choice = await chooseRevision(plugin, adocPath, mode, existing);
  if (!choice) return;
  if (choice.appendTo) {
    await appendPdfs(plugin, choice.appendTo, [pdfPath]);
    return;
  }
  const revision = choice.revision;

  // Re-opening the same PDF in the same round refreshes that mapping in place.
  const rebind = existing.find(
    (s) =>
      s.revision.id === revision.id &&
      !!s.pdfPath &&
      (path.normalize(s.pdfPath) === path.normalize(pdfPath) ||
        (!!s.pdf?.importedFrom && path.normalize(s.pdf.importedFrom) === path.normalize(pdfPath)))
  );
  const mapping = existing.length ? await promptMappingMeta(plugin, pdfPath, rebind?.mapping) : {};

  const toast = startOp(plugin, rebind ? "Eddie Doc: re-mapping PDF annotations" : "Eddie Doc: mapping PDF annotations");
  try {
    const session = await store.loadReview(adocPath, pdfPath, {
      threshold: plugin.settings.matchThreshold,
      revision,
      sidecarPath: rebind?.sidecarPath,
      mapping,
      pdfRole: rebind?.pdf?.role ?? "annotated",
      importPdf: plugin.settings.importPdfs,
      progress: toast.progress,
    });
    const matched = session.items.filter((i) => effectiveLine(i) !== UNMATCHED).length;
    notify(
      plugin,
      `Eddie Doc: ${revisionLabel(session.revision)} · ${mappingLabel(session)} — ` +
        `${session.items.length} annotation(s), ${matched} mapped to source.`
    );
    if (session.items.length >= 5 && matched / session.items.length < 0.4) {
      plugin.host.notify.warn(
        `Eddie Doc: only ${matched} of ${session.items.length} annotations mapped. Check that ` +
          `"${path.basename(pdfPath)}" is the annotated PDF for "${path.basename(adocPath)}", then use Triage.`
      );
    }
    await plugin.openSource(adocPath);
    if (plugin.settings.autoAnchor) await autoAnchorReview(plugin, adocPath);
    plugin.lastAdoc = adocPath;
    plugin.selection = null;
    await plugin.showPanel();
  } catch (e) {
    failed(plugin, "mapping the PDF", e);
  } finally {
    toast.done();
    plugin.refreshAll();
  }
}

export async function appendPdfs(plugin: EddiePlugin, sidecarPath?: string, given: string[] = []): Promise<void> {
  const { store } = plugin;
  const adoc = plugin.resolvedAdoc();
  const target = sidecarPath ? store.getBySidecar(sidecarPath) : adoc ? store.get(adoc) : undefined;
  if (!target) {
    notify(plugin, "Eddie Doc: open a document with a loaded review first.");
    return;
  }
  const pdfs = given.length ? given : [await pickPdf(plugin, "Select a PDF to add to this mapping")].filter((p): p is string => !!p);
  for (const pdfPath of pdfs) {
    const reviewer = await prompt(plugin.app, "Whose marks are on this PDF?", {
      detail: `${path.basename(pdfPath)} — leave empty if the PDF already names them.`,
    });
    if (reviewer === undefined) return;
    const toast = startOp(plugin, `Eddie Doc: reading ${path.basename(pdfPath)}`);
    try {
      const res = await store.appendPdf(target.sidecarPath, pdfPath, {
        threshold: plugin.settings.matchThreshold,
        reviewer: reviewer.trim() || undefined,
        importPdf: plugin.settings.importPdfs,
        progress: toast.progress,
      });
      if (res.alreadyPresent) notify(plugin, `Eddie Doc: ${path.basename(pdfPath)} is already part of this mapping.`);
      else {
        notify(
          plugin,
          `Eddie Doc: added ${res.added.length} mark(s) from ${path.basename(pdfPath)}` +
            (res.duplicates ? `, skipped ${res.duplicates} already present` : "") +
            "."
        );
      }
    } catch (e) {
      failed(plugin, `adding ${path.basename(pdfPath)}`, e);
      if (isCancelled(e)) break;
    } finally {
      toast.done();
    }
  }
  if (plugin.settings.autoAnchor) await autoAnchorReview(plugin, target.adocPath);
  plugin.refreshAll();
}

export async function remapAll(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  await plugin.saveSource(ctx.adocPath);
  const n = await plugin.store.remapAll(ctx.adocPath, plugin.settings.matchThreshold);
  notify(plugin, `Eddie Doc: re-mapped ${n} mapping(s).`);
}

export async function remapItem(plugin: EddiePlugin, ref = currentItem(plugin)): Promise<void> {
  if (!ref) return void needItem(plugin);
  await plugin.saveSource(ref.adocPath);
  await plugin.store.remapItem(ref.adocPath, ref.id, plugin.settings.matchThreshold);
  const item = plugin.store.findItem(ref.adocPath, ref.id);
  if (item && effectiveLine(item) !== UNMATCHED) await plugin.revealItem(ref.adocPath, ref.id);
  else notify(plugin, "Eddie Doc: no confident source match — use Re-link or Triage to place it by hand.");
}

// -- rounds and mappings --------------------------------------------------------------

export async function switchReview(plugin: EddiePlugin): Promise<void> {
  const docs = plugin.store.documents();
  if (!docs.length) return void notify(plugin, "Eddie Doc: no reviews loaded.");
  const picked = docs.length === 1 ? docs[0] : await choose(plugin.app, docs, (d) => d, "Open the review of…");
  if (!picked) return;
  plugin.lastAdoc = picked;
  await plugin.openSource(picked);
  plugin.setSelection(null);
  plugin.refreshAll();
}

export async function switchMapping(plugin: EddiePlugin): Promise<void> {
  const adoc = plugin.resolvedAdoc();
  const sessions = adoc ? plugin.store.sessionsFor(adoc) : [];
  if (sessions.length < 2) return void notify(plugin, "Eddie Doc: this document has only one mapping.");
  const picked = await choose(
    plugin.app,
    sessions,
    (s) =>
      `${revisionLabel(s.revision)} · ${mappingLabel(s)} — ${s.items.length} marks, ` +
      `${s.items.filter((i) => !i.resolved).length} open`,
    "Show which round / mapping?"
  );
  if (!picked) return;
  plugin.store.setActive(picked.sidecarPath);
  plugin.setSelection(null);
}

export async function editMappingInfo(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const { session } = ctx;
  const origin = await prompt(plugin.app, "Whose marks are in this mapping?", {
    detail: "An editor or site name.",
    value: session.mapping.origin ?? "",
  });
  if (origin === undefined) return;
  const round = await prompt(plugin.app, `Name for ${revisionLabel(session.revision)}`, {
    detail: "Shared by every mapping in the round. Leave empty to clear.",
    value: session.revision.label ?? "",
  });
  if (round === undefined) return;
  plugin.store.describeMapping(session.sidecarPath, {
    origin: origin.trim() || undefined,
    revision: { label: round.trim() || undefined },
  });
}

export async function deleteMapping(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const { session } = ctx;
  const ok = await confirm(
    plugin.app,
    `Remove ${mappingLabel(session)}?`,
    `Deletes ${path.basename(session.sidecarPath)} and the review state in it — resolved marks, notes and ` +
      `replies for this mapping. The manuscript, the PDF and any exported report are left alone.`,
    "Remove"
  );
  if (!ok) return;
  if (await plugin.store.deleteMapping(session.sidecarPath)) {
    notify(plugin, `Eddie Doc: removed ${mappingLabel(session)}.`);
    plugin.setSelection(null);
  }
}

export async function mergeMappings(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const { adocPath, session: target } = ctx;
  const others = plugin.store.sessionsFor(adocPath).filter((s) => s !== target);
  if (!others.length) return void notify(plugin, "Eddie Doc: there is no other mapping to merge in.");
  const picked = await choose(
    plugin.app,
    others,
    (s) => `${revisionLabel(s.revision)} · ${mappingLabel(s)} — ${s.items.length} marks`,
    `Merge into ${mappingLabel(target)}…`
  );
  if (!picked) return;
  const ok = await confirm(
    plugin.app,
    "Merge these mappings?",
    `${mappingLabel(picked)} is folded into ${mappingLabel(target)}, then its file is deleted. Marks it shares ` +
      `with the target are folded together.`,
    "Merge"
  );
  if (!ok) return;
  try {
    const res = await plugin.store.mergeMappings(target.sidecarPath, [picked.sidecarPath]);
    const folded = res.folded ? `, ${res.folded} repeated mark(s) folded in` : "";
    const msg = `Eddie Doc: merged ${res.removed.length} mapping(s) into ${mappingLabel(target)} — ${res.moved} mark(s) added${folded}.`;
    if (res.failed.length) plugin.host.notify.warn(`${msg} Could not delete: ${res.failed.join("; ")}`);
    else notify(plugin, msg);
  } catch (e) {
    plugin.host.notify.warn(`Eddie Doc: could not merge — ${String(e)}`);
  }
}

export async function migrateReviews(plugin: EddiePlugin): Promise<void> {
  const steps = plugin.store.planMigration();
  if (!steps.length) return void notify(plugin, "Eddie Doc: every review already lives in the review folder.");
  const ok = await confirm(
    plugin.app,
    `Move ${steps.length} review file(s) into the review folder?`,
    steps.map((s) => `${s.from}\n  → ${s.to}`).join("\n"),
    "Move"
  );
  if (!ok) return;
  const res = await plugin.store.migrate(steps);
  if (res.failed.length) plugin.host.notify.warn(`Eddie Doc: moved ${res.moved}, failed ${res.failed.length} — ${res.failed[0]}`);
  else notify(plugin, `Eddie Doc: moved ${res.moved} review file(s) into the review folder.`);
}

export async function openReviewFolder(plugin: EddiePlugin): Promise<void> {
  const folder = plugin.settings.reviewFolder;
  const adoc = plugin.resolvedAdoc();
  const docFolder = adoc ? documentFolder(plugin.store.layoutConfig, adoc) : undefined;
  const target = docFolder && (await plugin.host.storage.exists(docFolder)) ? docFolder : folder;
  const explorer = plugin.app.workspace.getLeavesOfType("file-explorer")[0];
  const view = explorer?.view as unknown as { revealInFolder?(f: unknown): void } | undefined;
  const f = plugin.app.vault.getAbstractFileByPath(target);
  if (view?.revealInFolder && f) {
    await plugin.app.workspace.revealLeaf(explorer);
    view.revealInFolder(f);
  } else notify(plugin, `Eddie Doc: the review folder is ${target}.`);
}

// -- per-annotation actions -------------------------------------------------------------

export function toggleResolved(plugin: EddiePlugin, ref = currentItem(plugin)): void {
  if (!ref) return void needItem(plugin);
  plugin.store.toggleResolved(ref.adocPath, ref.id);
}

export function confirmMatch(plugin: EddiePlugin, ref = currentItem(plugin)): void {
  if (!ref) return void needItem(plugin);
  plugin.store.confirmMatch(ref.adocPath, ref.id);
}

/** Link the selected annotation to the line the cursor is on. */
export async function relinkToCursor(plugin: EddiePlugin, ref = currentItem(plugin)): Promise<void> {
  if (!ref) return void needItem(plugin);
  const view = plugin.editorFor(ref.adocPath);
  if (!view) return void notify(plugin, "Eddie Doc: put the cursor on the source line in the editor first.");
  plugin.store.relink(ref.adocPath, ref.id, view.editor.getCursor().line);
}

/** Link the selected annotation to a line chosen from a list of suggestions and all lines. */
export async function relinkPick(plugin: EddiePlugin, ref = currentItem(plugin)): Promise<void> {
  if (!ref) return void needItem(plugin);
  const item = plugin.store.findItem(ref.adocPath, ref.id);
  if (!item) return;
  const picked = await pickLine(plugin, ref.adocPath, item);
  if (picked == null) return;
  plugin.store.relink(ref.adocPath, ref.id, picked);
  await plugin.revealLine(ref.adocPath, picked);
}

interface LineChoice {
  label: string;
  line: number;
}

async function pickLine(plugin: EddiePlugin, adocPath: string, item: ReviewItem): Promise<number | undefined> {
  const source = await plugin.readSource(adocPath);
  const lines = source.split(/\r?\n/);
  const text = (n: number) => lines[n].trim().replace(/\s+/g, " ");
  const anchorRaw = item.anchoredText || item.comment || "";
  const cands = topMatches(anchorRaw, buildSourceIndex(source), 5);
  const picks: LineChoice[] = cands.map((c) => ({
    label: `★ Line ${c.startLine + 1} (${c.score.toFixed(2)}) — ${text(c.startLine).slice(0, 90)}`,
    line: c.startLine,
  }));
  const seen = new Set(cands.map((c) => c.startLine));
  lines.forEach((_, n) => {
    if (!seen.has(n) && text(n)) picks.push({ label: `Line ${n + 1} — ${text(n).slice(0, 100)}`, line: n });
  });
  const hint = anchorRaw.replace(/\s+/g, " ").trim().slice(0, 60);
  return (await choose(plugin.app, picks, (p) => p.label, hint ? `Link “${hint}” to…` : "Link to which line?"))?.line;
}

/** Walk the unmatched annotations one by one, offering the likeliest lines. */
export async function triageUnmatched(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const queue = ctx.session.items.filter((i) => !i.resolved && effectiveLine(i) === UNMATCHED);
  if (!queue.length) return void notify(plugin, "Eddie Doc: no unmatched annotations to triage.");
  await plugin.openSource(ctx.adocPath);
  let linked = 0;
  for (const snap of queue) {
    const item = plugin.store.findItem(ctx.adocPath, snap.id);
    if (!item || item.resolved || effectiveLine(item) !== UNMATCHED) continue;
    plugin.setSelection({ adocPath: ctx.adocPath, id: item.id });
    void previewPdf(plugin, ctx.adocPath, item.id, false);
    const line = await pickLine(plugin, ctx.adocPath, item);
    if (line == null) break;
    plugin.store.relink(ctx.adocPath, item.id, line);
    linked++;
    await plugin.revealLine(ctx.adocPath, line);
  }
  notify(plugin, `Eddie Doc: triage — ${linked} linked, ${queue.length - linked} left.`);
}

export async function applyAction(plugin: EddiePlugin, action: EditAction, ref = currentItem(plugin)): Promise<void> {
  if (!ref) return void needItem(plugin);
  const item = plugin.store.findItem(ref.adocPath, ref.id);
  if (!item) return;
  const source = await plugin.readSource(ref.adocPath);
  let edit: TextEdit | null = null;
  switch (action) {
    case "delete-struck":
      edit = planDeleteStruck(source, item);
      break;
    case "delete-lines":
      edit = planDeleteLines(source, item);
      break;
    case "insert-note":
      edit = planInsertNote(source, item);
      break;
    case "replace-marked": {
      const range = planReplaceMarked(source, item, "");
      if (!range) break;
      const current = source.slice(range.from, range.to);
      const text = await prompt(plugin.app, "Replace marked text", {
        detail: `Replacing “${current.slice(0, 60)}”`,
        value: parseSuggestion(item.comment) || current,
      });
      if (text == null) return;
      edit = planReplaceMarked(source, item, text);
      break;
    }
    case "insert-at-mark": {
      const text = await prompt(plugin.app, "Insert text at mark", {
        value: parseSuggestion(item.comment),
      });
      if (text == null) return;
      edit = planInsertAtMark(source, item, text);
      break;
    }
  }
  if (!edit) {
    return void notify(
      plugin,
      "Eddie Doc: couldn't pin the marked text precisely — edit by hand, or use “Delete whole line(s)”."
    );
  }
  if (!(await applyTextEdits(plugin, ref.adocPath, [edit]))) return;
  // Inserting a note changes nothing about the annotation; the others settle it.
  if (action !== "insert-note" && !item.resolved) plugin.store.toggleResolved(ref.adocPath, ref.id);
}

export async function applyAllConfident(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const source = await plugin.readSource(ctx.adocPath);
  const high = plugin.settings.highConfidence;
  const planned = planAllConfident(source, ctx.session.items, (i) => isConfident(i, high));
  if (!planned.length) return void notify(plugin, "Eddie Doc: no actionable, confident edits to apply.");
  if (overlaps(planned.map((p) => p.edit))) {
    return void plugin.host.notify.warn("Eddie Doc: some edits overlap — apply them one at a time.");
  }
  const ok = await confirm(
    plugin.app,
    `Apply ${planned.length} edit(s) to ${path.basename(ctx.adocPath)}?`,
    planned.map((p, i) => `${i + 1}. ${p.label}`).join("\n"),
    "Apply all"
  );
  if (!ok) return;
  if (!(await applyTextEdits(plugin, ctx.adocPath, planned.map((p) => p.edit)))) return;
  for (const p of planned) plugin.store.toggleResolved(ctx.adocPath, p.id);
  notify(plugin, `Eddie Doc: applied ${planned.length} edit(s).`);
}

/** Apply edits to the source as one undoable editor transaction. */
async function applyTextEdits(plugin: EddiePlugin, adocPath: string, edits: TextEdit[]): Promise<boolean> {
  const view = await plugin.openSource(adocPath);
  if (!view) return false;
  const ed = view.editor;
  ed.transaction({
    changes: edits.map((e) => ({ from: ed.offsetToPos(e.from), to: ed.offsetToPos(e.to), text: e.insert })),
  });
  return true;
}

// -- anchors --------------------------------------------------------------------------

/**
 * Pin freshly imported marks to their paragraphs with `// eddie:<id>` comments.
 * Import is the one moment the source still resembles what the editor read, so
 * it is the only moment matching can be trusted. Saved at once when the file is
 * clean; if the author has unsaved work, their edits are not ours to commit.
 */
export async function autoAnchorReview(plugin: EddiePlugin, adocPath: string): Promise<void> {
  const view = await plugin.openSource(adocPath, false);
  if (!view) return;
  const before = view.editor.getValue();
  const wasDirty = before !== (await plugin.host.storage.readText(adocPath));
  const res = plugin.store.buildAnchors(adocPath, before);
  if (!res || res.inserted === 0) return;
  view.editor.transaction({
    changes: [{ from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(before.length), text: res.source }],
  });
  if (!wasDirty) await view.save();
  await plugin.store.remapAll(adocPath, plugin.settings.matchThreshold);
  notify(
    plugin,
    `Eddie Doc: anchored ${res.anchored} annotation(s) with ${res.inserted} marker comment(s)` +
      `${wasDirty ? " — save the file to keep them" : ""}. They never render; “Remove source anchors” takes them out.`
  );
}

export async function anchorSource(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const view = await plugin.openSource(ctx.adocPath);
  if (!view) return;
  const before = view.editor.getValue();
  const res = plugin.store.buildAnchors(ctx.adocPath, before);
  if (!res) return;
  if (res.inserted === 0) {
    return void notify(
      plugin,
      res.anchored > 0
        ? `Eddie Doc: all ${res.anchored} located annotation(s) were already anchored.`
        : "Eddie Doc: nothing to anchor — no annotation has a source location yet."
    );
  }
  const ok = await confirm(
    plugin.app,
    `Anchor ${res.anchored} annotation(s) in ${path.basename(ctx.adocPath)}?`,
    `${res.inserted} marker comment(s) will be added to the source. Markers are AsciiDoc comments — they ` +
      `never render, and keep annotations attached to their paragraph even when the text is rewritten. ` +
      `Applied as one undoable edit.`,
    "Anchor"
  );
  if (!ok) return;
  view.editor.transaction({
    changes: [{ from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(before.length), text: res.source }],
  });
  await plugin.store.remap(ctx.adocPath, plugin.settings.matchThreshold);
  notify(plugin, `Eddie Doc: anchored ${res.anchored} annotation(s) with ${res.inserted} marker(s).`);
}

export async function stripAnchors(plugin: EddiePlugin): Promise<void> {
  const adocPath = plugin.resolvedAdoc();
  if (!adocPath) return;
  const view = await plugin.openSource(adocPath);
  if (!view) return;
  const before = view.editor.getValue();
  const after = stripMarkers(before);
  if (after === before) return void notify(plugin, "Eddie Doc: no markers in this document.");
  const removed = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
  const ok = await confirm(
    plugin.app,
    `Remove ${removed} marker comment(s) from ${path.basename(adocPath)}?`,
    "Annotations will fall back to block ids, fingerprints and text matching, so some may drift on the next re-map.",
    "Remove"
  );
  if (!ok) return;
  view.editor.transaction({
    changes: [{ from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(before.length), text: after }],
  });
}

// -- replies --------------------------------------------------------------------------

export async function addReply(plugin: EddiePlugin, ref: ItemRef, body: string): Promise<boolean> {
  const author = await plugin.ensureAuthor((t, o) => prompt(plugin.app, t, o));
  if (!author) return false;
  plugin.store.addReply(ref.adocPath, ref.id, author, body);
  return true;
}

// -- outputs --------------------------------------------------------------------------

export async function exportReport(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const { adocPath, session } = ctx;
  const md = renderReport(session, {
    highConfidence: plugin.settings.highConfidence,
    stale: await isSessionStale(session, plugin.host.storage),
    generatedAt: stamp(),
  });
  const out = outputPath(plugin, session, "reportOutput", adocPath.replace(/\.adoc$/i, "") + ".review.md", "report");
  try {
    await plugin.host.storage.writeText(out, md);
  } catch (e) {
    return void plugin.host.notify.warn(`Eddie Doc: could not write report — ${String(e)}`);
  }
  plugin.store.recordArtifact(session.sidecarPath, { kind: "report", path: out, createdAt: stamp() });
  const file = plugin.app.vault.getAbstractFileByPath(out);
  if (file instanceof TFile) await plugin.app.workspace.getLeaf("tab").openFile(file);
  else notify(plugin, `Eddie Doc: report written to ${out}.`);
}

export async function stampReviewedPdf(plugin: EddiePlugin): Promise<void> {
  const ctx = needSession(plugin);
  if (!ctx) return;
  const { adocPath, session } = ctx;
  const fresh = await pickPdf(plugin, "Select the freshly generated PDF to stamp");
  if (!fresh) return;
  const out = outputPath(plugin, session, "stampOutput", fresh.replace(/\.pdf$/i, "") + ".reviewed.pdf", "pdf");
  const toast = startOp(plugin, "Eddie Doc: stamping review");
  try {
    await plugin.saveSource(adocPath);
    const bytes = await plugin.host.storage.readBytes(fresh);
    const pages = await readPages(bytes, toast.progress);
    const source = await plugin.readSource(adocPath);
    const { anchored, unstamped } = anchorItems(session.items, source, pages);
    const result = await stampPdf(bytes, anchored);
    await plugin.host.storage.writeBytes(out, result.bytes);
    plugin.store.recordArtifact(session.sidecarPath, {
      kind: "stampedPdf",
      path: out,
      createdAt: stamp(),
      note: `stamped from ${path.basename(fresh)}`,
    });
    notify(
      plugin,
      `Eddie Doc: stamped ${result.marks} mark(s) and ${result.replies} repl(ies) into ${path.basename(out)}` +
        (unstamped.length ? ` · ${unstamped.length} could not be placed` : "")
    );
    if (unstamped.length) await showUnplaced(plugin, session, unstamped);
    await plugin.app.workspace.openLinkText(out, adocPath, "split");
  } catch (e) {
    failed(plugin, "stamping the PDF", e);
  } finally {
    toast.done();
  }
}

async function showUnplaced(
  plugin: EddiePlugin,
  session: ReviewSession,
  unstamped: Array<{ item: ReviewItem; reason: string }>
): Promise<void> {
  const lines = [
    `# Annotations that could not be placed (${unstamped.length})`,
    "",
    "These stayed out of the stamped PDF rather than being guessed at.",
    "",
  ];
  for (const u of unstamped) {
    const text = (u.item.comment || u.item.anchoredText || "").replace(/\s+/g, " ").trim();
    lines.push(`- **${KIND_LABEL[u.item.kind]}** · p${u.item.page} — ${u.reason}`);
    if (text) lines.push(`  > ${text.slice(0, 200)}`);
  }
  const folder = documentFolder(plugin.store.layoutConfig, session.adocPath) ?? path.dirname(session.adocPath);
  const out = path.join(folder, session.revision.id, `${session.mapping.id}.unplaced.md`);
  await plugin.host.storage.writeText(out, lines.join("\n") + "\n");
  const f = plugin.app.vault.getAbstractFileByPath(out);
  if (f instanceof TFile) await plugin.app.workspace.getLeaf("tab").openFile(f);
}

export async function extractAnnotationsToAdoc(plugin: EddiePlugin): Promise<void> {
  const pdf = await pickPdf(plugin, "Select the annotated PDF to extract");
  if (!pdf) return;
  const toast = startOp(plugin, "Eddie Doc: extracting PDF annotations");
  try {
    const bytes = await plugin.host.storage.readBytes(pdf);
    const annots = await extractAnnotations(bytes, toast.progress);
    const adoc = annotationsToAdoc(pdf, annots, stamp());
    const target = await prompt(plugin.app, "Save the extracted annotations as", {
      detail: "A vault path for the new .adoc file.",
      value: extractedAdocPath(pdf),
    });
    if (!target?.trim()) return;
    await plugin.host.storage.writeText(target.trim(), adoc);
    notify(plugin, `Eddie Doc: extracted ${annots.length} annotation(s) to ${path.basename(target)}.`);
    await plugin.openSource(target.trim());
  } catch (e) {
    failed(plugin, "extracting annotations", e);
  } finally {
    toast.done();
  }
}

// -- navigation & preview -----------------------------------------------------------------

/** Jump to the next or previous annotated line from the cursor. */
export async function jump(plugin: EddiePlugin, dir: 1 | -1): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file;
  if (!view || !file || !isAdocPath(file.path)) return;
  const session = plugin.store.get(file.path);
  if (!session) return;
  const lines = [...new Set(session.items.map((i) => effectiveLine(i)).filter((l) => l !== UNMATCHED))].sort((a, b) => a - b);
  if (!lines.length) return;
  const cur = view.editor.getCursor().line;
  const next = dir === 1 ? lines.find((l) => l > cur) ?? lines[0] : [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];
  await plugin.revealLine(file.path, next);
  const hit = session.items.find((i) => effectiveLine(i) === next);
  if (hit) plugin.setSelection({ adocPath: file.path, id: hit.id });
}

/** The PDF an item came from: one added to the mapping, or the mapping's own. */
function pdfOf(session: ReviewSession, item: ReviewItem): string | undefined {
  if (item.pdfId) {
    const extra = session.extraPdfs?.find((p) => p.id === item.pdfId);
    if (extra) return extra.path;
  }
  return session.pdfPath || undefined;
}

/** Page geometry is read from the PDF once per page and remembered for the session. */
const geometryCache = new Map<string, Awaited<ReturnType<typeof readPageGeometry>>>();

/**
 * Show the PDF at the annotation's page, with its rectangle marked.
 *
 * Two ways, chosen by the `pdfPreview` setting: Obsidian's built-in viewer via a
 * `#page=N&rect=…` link (the page is honoured; the rectangle depends on the
 * viewer), or Eddie's own view, which draws the page and the rectangle itself.
 * Either reuses one tab, and keeps keyboard focus where it was when `focus` is
 * false (the panel follows the selection without stealing it).
 */
export async function previewPdf(plugin: EddiePlugin, adocPath: string, id: string, focus = true): Promise<void> {
  const session = plugin.store.get(adocPath);
  const item = session?.items.find((i) => i.id === id);
  if (!session || !item) return;
  const pdf = pdfOf(session, item);
  if (!pdf || !(await plugin.host.storage.exists(pdf))) {
    return void plugin.host.notify.warn(`Eddie Doc: the PDF for this annotation is missing (${pdf ?? "no path recorded"}).`);
  }
  if (plugin.settings.pdfPreview === "own") {
    try {
      await plugin.showPdfPreview(pdf, item.page, item.rect as number[] | undefined);
      return;
    } catch (e) {
      plugin.host.notify.warn(`Eddie Doc: Eddie's viewer failed (${String(e)}); using Obsidian's.`);
    }
  }

  const gkey = `${pdf}#${item.page}`;
  if (!geometryCache.has(gkey)) {
    geometryCache.set(gkey, await readPageGeometry(await plugin.host.storage.readBytes(pdf), item.page).catch(() => undefined));
  }
  const geo = geometryCache.get(gkey);
  const link =
    pdf +
    pdfFragment(item.page, item.rect as PdfRect | undefined, plugin.settings.pdfRectMode, geo ? { view: geo.view } : undefined);

  const { workspace } = plugin.app;
  const reuse = plugin.previewLeaf;
  if (reuse && reuse.view?.getViewType() === "pdf" && workspace.getLeavesOfType("pdf").includes(reuse)) {
    workspace.setActiveLeaf(reuse, { focus });
    await workspace.openLinkText(link, adocPath, false);
  } else {
    await workspace.openLinkText(link, adocPath, "split");
    plugin.previewLeaf = workspace.getMostRecentLeaf() ?? undefined;
  }
  if (!focus) {
    const editor = plugin.editorFor(adocPath);
    if (editor) workspace.setActiveLeaf(editor.leaf, { focus: true });
  }
}

export { PDF_ROLE_LABEL };
