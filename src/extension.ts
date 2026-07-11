import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ReviewStore } from "./model/store.js";
import { AnnotationTreeProvider } from "./ui/treeProvider.js";
import { DecorationManager } from "./ui/decorations.js";
import { DiagnosticsManager } from "./ui/diagnostics.js";
import { EddieCodeActionProvider } from "./ui/codeActions.js";
import { effectiveLine } from "./matching/mapper.js";
import type { ReviewItem } from "./model/types.js";
import { KIND_LABEL } from "./model/types.js";
import { countNewlines, type ContentChange } from "./matching/posTrack.js";
import { isAdocDoc, isAdocPath } from "./util.js";
import { resolveMarkedRange, resolveInsertPosition } from "./ui/precise.js";
import { extractAnnotations } from "./pdf/extract.js";
import { annotationsToAdoc, extractedAdocPath } from "./pdf/toAdoc.js";
import { PdfPreviewPanel } from "./ui/pdfPreview.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

function threshold(): number {
  return vscode.workspace
    .getConfiguration("eddieDoc")
    .get<number>("matchThreshold", 0.5);
}

function activeAdocPath(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (ed && isAdocDoc(ed.document)) return ed.document.uri.fsPath;
  return undefined;
}

/** Resolve the .adoc a command should act on: active editor, else visible. */
function resolveTargetAdoc(store: ReviewStore): string | undefined {
  const active = activeAdocPath();
  if (active) return active;
  const visible = vscode.window.visibleTextEditors.find((e) =>
    isAdocDoc(e.document)
  );
  if (visible) return visible.document.uri.fsPath;
  const sessions = store.all();
  return sessions.length ? sessions[sessions.length - 1].adocPath : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new ReviewStore();
  const tree = new AnnotationTreeProvider(store, activeAdocPath);
  const decorations = new DecorationManager(store);
  const diagnostics = new DiagnosticsManager(store);
  const preview = new PdfPreviewPanel(context.extensionUri);

  const treeView = vscode.window.createTreeView("eddieDoc.annotations", {
    treeDataProvider: tree,
  });

  // Once the preview panel is open, follow the tree selection so browsing the
  // annotation list re-renders the matching PDF region live.
  treeView.onDidChangeSelection((e) => {
    if (!preview.isOpen) return;
    const node = e.selection[0];
    if (node && node.type === "item") {
      previewItem(store, preview, node.adocPath, node.item.id);
    }
  });

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { language: "asciidoc" },
        { pattern: "**/*.adoc" },
        { pattern: "**/*.asciidoc" },
      ],
      new EddieCodeActionProvider(store),
      { providedCodeActionKinds: EddieCodeActionProvider.kinds }
    )
  );

  // Load any persisted sidecars for already-open .adoc documents.
  for (const doc of vscode.workspace.textDocuments) {
    if (isAdocDoc(doc)) store.tryLoadSidecar(doc.uri.fsPath);
  }

  let treeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshUI = () => {
    tree.refresh();
    decorations.update(vscode.window.activeTextEditor);
    diagnostics.update(vscode.window.activeTextEditor?.document);
  };
  context.subscriptions.push(store.onDidChange(refreshUI));

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isAdocDoc(ed.document))
        store.tryLoadSidecar(ed.document.uri.fsPath);
      refreshUI();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("eddieDoc")) refreshUI();
    }),
    // Re-map on save so annotation positions stay correct after edits (e.g.
    // after inserting a note line, which shifts everything below it).
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (isAdocDoc(doc) && store.get(doc.uri.fsPath)) {
        await store.remap(doc.uri.fsPath, threshold());
      }
    }),
    // Live position tracking: shift annotation anchors with the text as the user
    // types so every command stays addressable *between* saves (the save-time
    // remap then reconciles by content). Decorations/diagnostics update at once;
    // the tree label refresh is debounced to avoid churn while typing.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isAdocDoc(e.document) || e.contentChanges.length === 0) return;
      if (!store.get(e.document.uri.fsPath)) return;
      const changes: ContentChange[] = e.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        endLine: c.range.end.line,
        newLineCount: countNewlines(c.text),
      }));
      if (!store.shiftPositions(e.document.uri.fsPath, changes)) return;
      const ed = vscode.window.visibleTextEditors.find(
        (v) => v.document === e.document
      );
      decorations.update(ed);
      diagnostics.update(e.document);
      if (treeRefreshTimer) clearTimeout(treeRefreshTimer);
      treeRefreshTimer = setTimeout(() => tree.refresh(), 300);
    })
  );

  // ---- Commands -----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("eddieDoc.openReview", async (arg?: vscode.Uri) => {
      const pair = await resolveReviewPair(store, arg);
      if (!pair) return;
      const { adocPath, pdfPath } = pair;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Eddie Doc: mapping PDF annotations…",
        },
        async () => {
          try {
            const session = await store.loadReview(
              adocPath,
              pdfPath,
              threshold()
            );
            const matched = session.items.filter(
              (i) => effectiveLine(i) !== UNMATCHED
            ).length;
            vscode.window.showInformationMessage(
              `Eddie Doc: ${session.items.length} annotation(s), ${matched} mapped to source.`
            );
            await vscode.commands.executeCommand(
              "eddieDoc.annotations.focus"
            );
          } catch (e) {
            vscode.window.showErrorMessage(
              `Eddie Doc: failed to read PDF — ${String(e)}`
            );
          }
        }
      );
    }),

    vscode.commands.registerCommand("eddieDoc.refresh", async () => {
      const adocPath = resolveTargetAdoc(store);
      if (!adocPath || !store.get(adocPath)) {
        vscode.window.showInformationMessage(
          "Eddie Doc: no review loaded to re-map."
        );
        return;
      }
      await store.remap(adocPath, threshold());
    }),

    vscode.commands.registerCommand(
      "eddieDoc.extractAnnotations",
      async (arg?: vscode.Uri) => {
        await extractAnnotationsToAdoc(arg);
      }
    ),

    vscode.commands.registerCommand(
      "eddieDoc.revealAnnotation",
      async (adocPath: string, id: string) => {
        await revealItem(store, adocPath, id);
      }
    ),

    vscode.commands.registerCommand(
      "eddieDoc.toggleResolved",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        store.toggleResolved(ref.adocPath, ref.id);
      }
    ),

    vscode.commands.registerCommand("eddieDoc.relink", async (arg?: unknown) => {
      const ref = resolveItemRef(store, arg);
      if (!ref) return;
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.fsPath !== ref.adocPath) {
        vscode.window.showWarningMessage(
          "Eddie Doc: put your cursor on the target line in the .adoc, then re-link."
        );
        return;
      }
      store.relink(ref.adocPath, ref.id, ed.selection.active.line);
      vscode.window.showInformationMessage(
        `Eddie Doc: re-linked to line ${ed.selection.active.line + 1}.`
      );
    }),

    // Reselect the source line via a searchable line picker — works from the
    // tree for any item (including unmatched ones) without touching the cursor.
    vscode.commands.registerCommand(
      "eddieDoc.relinkPick",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        await relinkViaPick(store, ref);
      }
    ),

    // Re-run automatic matching for a single annotation, discarding any manual
    // link, and reveal the result.
    vscode.commands.registerCommand(
      "eddieDoc.remapItem",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        store.remapItem(ref.adocPath, ref.id, threshold());
        const item = store.findItem(ref.adocPath, ref.id);
        if (item && effectiveLine(item) !== UNMATCHED) {
          await revealItem(store, ref.adocPath, ref.id);
        } else {
          vscode.window.showInformationMessage(
            "Eddie Doc: no confident source match — use Reselect to link it by hand."
          );
        }
      }
    ),

    // Vouch for a low-confidence / semantic match so it moves out of "Needs
    // review" into the Open group.
    vscode.commands.registerCommand(
      "eddieDoc.confirmMatch",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        store.confirmMatch(ref.adocPath, ref.id);
      }
    ),

    // Batch-apply every actionable, confidently-matched edit (deletes for
    // strikeouts, replaces/inserts with a parseable suggestion) as one undoable
    // step, after a preview.
    vscode.commands.registerCommand("eddieDoc.applyAllEdits", async () => {
      await applyAllEdits(store);
    }),

    // Open (or update) the PDF preview showing this annotation's page + mark.
    vscode.commands.registerCommand(
      "eddieDoc.previewAnnotation",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        previewItem(store, preview, ref.adocPath, ref.id);
      }
    ),

    vscode.commands.registerCommand(
      "eddieDoc.replaceMarked",
      async (adocPath: string, id: string) => {
        await applyReplace(store, adocPath, id);
      }
    ),

    vscode.commands.registerCommand(
      "eddieDoc.insertAtMark",
      async (adocPath: string, id: string) => {
        await applyInsert(store, adocPath, id);
      }
    ),

    vscode.commands.registerCommand("eddieDoc.nextAnnotation", () =>
      jump(store, +1)
    ),
    vscode.commands.registerCommand("eddieDoc.prevAnnotation", () =>
      jump(store, -1)
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() =>
      decorations.update(vscode.window.activeTextEditor)
    ),
    treeView,
    decorations,
    diagnostics,
    { dispose: () => preview.dispose() },
    { dispose: () => store.dispose() }
  );

  refreshUI();
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}

// ---- Helpers --------------------------------------------------------------

interface ReviewPair {
  adocPath: string;
  pdfPath: string;
}

/**
 * Work out which (.adoc, .pdf) pair to review. `arg` is the resource passed by an
 * Explorer/editor context-menu invocation and may point at either file type;
 * when absent (command palette / view title) we fall back to the active source.
 */
async function resolveReviewPair(
  store: ReviewStore,
  arg?: vscode.Uri
): Promise<ReviewPair | undefined> {
  const fsPath = arg?.fsPath;

  // Right-clicked a PDF: let the user choose the .adoc source explicitly
  // (no filename matching). Default the dialog to the active/sibling .adoc as a
  // convenience, but the choice is always the user's.
  if (fsPath && /\.pdf$/i.test(fsPath)) {
    const suggested = resolveTargetAdoc(store) ?? siblingAdoc(fsPath);
    const adocPath = await pickAdoc(fsPath, suggested);
    if (!adocPath) return undefined;
    return { adocPath, pdfPath: fsPath };
  }

  // Right-clicked an .adoc (or no arg): use it, then pick the PDF.
  const adocPath =
    fsPath && isAdocPath(fsPath) ? fsPath : resolveTargetAdoc(store);
  if (!adocPath) {
    vscode.window.showErrorMessage(
      "Eddie Doc: open the .adoc file you want to review first."
    );
    return undefined;
  }
  const pdfPath = await pickPdf(adocPath);
  if (!pdfPath) return undefined;
  return { adocPath, pdfPath };
}

/**
 * Side feature: extract a PDF's annotations (with their anchored context) into a
 * standalone .adoc file — no source mapping, no review session. Opens the result.
 */
async function extractAnnotationsToAdoc(arg?: vscode.Uri): Promise<void> {
  let pdfPath = arg?.fsPath;
  if (!pdfPath || !/\.pdf$/i.test(pdfPath)) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Extract annotations",
      title: "Select the annotated PDF to extract",
      filters: { PDF: ["pdf"] },
    });
    pdfPath = picked?.[0]?.fsPath;
  }
  if (!pdfPath) return;
  const source = pdfPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Eddie Doc: extracting PDF annotations…",
    },
    async () => {
      try {
        const bytes = new Uint8Array(fs.readFileSync(source));
        const annots = await extractAnnotations(bytes);
        const adoc = annotationsToAdoc(source, annots, new Date().toISOString());

        const defaultUri = vscode.Uri.file(extractedAdocPath(source));
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          saveLabel: "Save annotations",
          filters: { AsciiDoc: ["adoc", "asciidoc"] },
        });
        if (!target) return;

        fs.writeFileSync(target.fsPath, adoc, "utf8");
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(
          `Eddie Doc: extracted ${annots.length} annotation(s) to ${path.basename(target.fsPath)}.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Eddie Doc: failed to extract annotations — ${String(e)}`
        );
      }
    }
  );
}

/** Find the .adoc that sits next to a PDF (foo.pdf / foo.annotated.pdf → foo.adoc). */
function siblingAdoc(pdfPath: string): string | undefined {
  const base = pdfPath.replace(/(\.annotated)?\.pdf$/i, "");
  for (const ext of [".adoc", ".asciidoc"]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Prompt for the .adoc source to map a PDF's annotations onto. */
async function pickAdoc(
  pdfPath: string,
  suggested?: string
): Promise<string | undefined> {
  const defaultUri = vscode.Uri.file(suggested ?? path.dirname(pdfPath));
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Review with this PDF",
    title: "Select the AsciiDoc source to map annotations onto",
    defaultUri,
    filters: { AsciiDoc: ["adoc", "asciidoc", "asc", "ad"] },
  });
  const chosen = picked?.[0]?.fsPath;
  if (chosen && !isAdocPath(chosen)) {
    vscode.window.showErrorMessage(
      "Eddie Doc: please pick an AsciiDoc file (.adoc / .asciidoc)."
    );
    return undefined;
  }
  return chosen;
}

async function pickPdf(adocPath: string): Promise<string | undefined> {
  const sibling = adocPath.replace(/\.adoc$/i, "") + ".pdf";
  const annotatedSibling =
    adocPath.replace(/\.adoc$/i, "") + ".annotated.pdf";
  const defaultUri = fs.existsSync(annotatedSibling)
    ? vscode.Uri.file(annotatedSibling)
    : fs.existsSync(sibling)
      ? vscode.Uri.file(sibling)
      : vscode.Uri.file(path.dirname(adocPath));

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Map annotations",
    defaultUri,
    filters: { PDF: ["pdf"] },
  });
  return picked?.[0]?.fsPath;
}

async function revealItem(
  store: ReviewStore,
  adocPath: string,
  id: string
): Promise<void> {
  const item = store.findItem(adocPath, id);
  if (!item) return;
  const line = effectiveLine(item);
  if (line === UNMATCHED) return;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
  });
  const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

interface LinePick extends vscode.QuickPickItem {
  line: number;
}

/**
 * Reselect an annotation's source line with a searchable quick pick. The picker
 * lists every non-blank source line, pre-selects the current match, and seeds
 * the filter with a few words from the annotation so the likely lines surface
 * first. Unlike cursor-based re-link, this works entirely from the tree view.
 */
async function relinkViaPick(store: ReviewStore, ref: ItemRef): Promise<void> {
  const item = store.findItem(ref.adocPath, ref.id);
  if (!item) return;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(ref.adocPath)
  );

  const picks: LinePick[] = [];
  for (let n = 0; n < doc.lineCount; n++) {
    const text = doc.lineAt(n).text.trim();
    if (!text) continue;
    picks.push({
      label: `Line ${n + 1}`,
      description: text.length > 100 ? text.slice(0, 100) + "…" : text,
      line: n,
    });
  }
  if (picks.length === 0) return;

  const current = effectiveLine(item);
  const anchor = (item.anchoredText || item.comment || "")
    .replace(/\s+/g, " ")
    .trim();

  const chosen = await new Promise<LinePick | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<LinePick>();
    qp.title = `Reselect source line — ${KIND_LABEL[item.kind]}`;
    qp.placeholder = anchor
      ? `Link “${anchor.slice(0, 60)}” to a source line`
      : "Choose the source line to link this annotation to";
    qp.matchOnDescription = true;
    qp.items = picks;
    // Seed the filter with distinctive words so relevant lines float up.
    qp.value = anchor.split(" ").slice(0, 4).join(" ");
    if (current !== UNMATCHED) {
      const active = picks.find((p) => p.line === current);
      if (active) qp.activeItems = [active];
    }
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
  if (!chosen) return;

  store.relink(ref.adocPath, ref.id, chosen.line);
  await revealItem(store, ref.adocPath, ref.id);
  vscode.window.showInformationMessage(
    `Eddie Doc: linked to line ${chosen.line + 1}.`
  );
}

/** Open/refresh the PDF preview for an annotation (matched or not). */
function previewItem(
  store: ReviewStore,
  preview: PdfPreviewPanel,
  adocPath: string,
  id: string
): void {
  const session = store.get(adocPath);
  const item = store.findItem(adocPath, id);
  if (!session || !item) return;
  preview.show(
    session.pdfPath,
    item.page,
    item.rect,
    `${KIND_LABEL[item.kind]} · p${item.page}`
  );
}

/** Best-guess replacement text from a free-form editor comment. */
function parseSuggestion(comment: string): string {
  const c = comment.replace(/\s+/g, " ").trim();
  // Prefer text inside quotes: 'like this' or "like this" or “smart quotes”.
  const q = c.match(/['"“”‘’«»]([^'"“”‘’«»]{2,})['"“”‘’«»]/);
  if (q) return q[1].trim();
  // Strip a leading directive like "Reword:" / "Replace with -".
  const stripped = c.replace(
    /^(reword|replace(?:\s+with)?|change(?:\s+to)?|use|rewrite(?:\s+as)?)\s*[:\-–—]?\s*/i,
    ""
  );
  return stripped.trim();
}

async function applyReplace(
  store: ReviewStore,
  adocPath: string,
  id: string
): Promise<void> {
  const item = store.findItem(adocPath, id);
  if (!item) return;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const range = resolveMarkedRange(doc, item);
  if (!range) {
    vscode.window.showWarningMessage(
      "Eddie Doc: couldn't pin the marked text precisely — edit by hand, or use 'Delete whole struck line'."
    );
    return;
  }
  const current = doc.getText(range);
  const value = parseSuggestion(item.comment) || current;
  const replacement = await vscode.window.showInputBox({
    title: "Replace marked text",
    prompt: `Replacing “${current.slice(0, 60)}”`,
    value,
    valueSelection: [0, value.length],
  });
  if (replacement == null) return;
  if (!(await confirmDiff("Apply this replacement?", current, replacement)))
    return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, replacement);
  await vscode.workspace.applyEdit(edit);
  store.toggleResolved(adocPath, id);
  await revealItem(store, adocPath, id);
}

/**
 * Modal before/after confirmation. Returns true when the user approves (or the
 * change is a no-op). Keeps destructive/text edits an explicit, reviewed step.
 */
async function confirmDiff(
  prompt: string,
  before: string,
  after: string
): Promise<boolean> {
  if (before === after) return true;
  const detail = `- ${before.replace(/\s+/g, " ").trim()}\n+ ${after
    .replace(/\s+/g, " ")
    .trim()}`;
  const pick = await vscode.window.showInformationMessage(
    prompt,
    { modal: true, detail },
    "Apply"
  );
  return pick === "Apply";
}

async function applyInsert(
  store: ReviewStore,
  adocPath: string,
  id: string
): Promise<void> {
  const item = store.findItem(adocPath, id);
  if (!item) return;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const pos = resolveInsertPosition(doc, item);
  if (!pos) {
    vscode.window.showWarningMessage(
      "Eddie Doc: couldn't locate the insertion point — edit by hand."
    );
    return;
  }
  const value = parseSuggestion(item.comment);
  const text = await vscode.window.showInputBox({
    title: "Insert text at mark",
    prompt: "Text to insert at the caret position",
    value,
    valueSelection: [0, value.length],
  });
  if (text == null || text === "") return;
  if (!(await confirmDiff("Insert this text?", "", text))) return;
  // Add surrounding spaces only where the neighbours aren't already spaced.
  const before = pos.character > 0 ? doc.getText(
    new vscode.Range(pos.translate(0, -1), pos)
  ) : " ";
  const lead = /\s/.test(before) || /^\s/.test(text) ? "" : " ";
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, pos, `${lead}${text}`);
  await vscode.workspace.applyEdit(edit);
  store.toggleResolved(adocPath, id);
  await revealItem(store, adocPath, id);
}

/** Score at/above which an auto-match is treated as high-confidence. */
function highConfidence(): number {
  return vscode.workspace
    .getConfiguration("eddieDoc")
    .get<number>("highConfidence", 0.75);
}

/** A link we trust enough to act on without a manual look. */
function isConfident(item: ReviewItem, highConf: number): boolean {
  if (item.manualLine != null || item.confirmed) return true;
  return (item.match?.score ?? 0) >= highConf;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

interface PlannedEdit {
  id: string;
  label: string;
  apply: (edit: vscode.WorkspaceEdit, uri: vscode.Uri) => void;
}

/**
 * Collect every actionable, confidently-matched edit and apply them as a single
 * undoable WorkspaceEdit after a preview. Deletes struck text, applies
 * replacements/insertions whose reviewer comment yields a suggestion. Skips
 * highlights/comments with nothing to change and anything low-confidence.
 */
async function applyAllEdits(store: ReviewStore): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const session = adocPath ? store.get(adocPath) : undefined;
  if (!adocPath || !session) {
    vscode.window.showInformationMessage("Eddie Doc: no review loaded.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const highConf = highConfidence();

  const planned: PlannedEdit[] = [];
  for (const item of session.items) {
    if (item.resolved) continue;
    const line = effectiveLine(item);
    if (line === UNMATCHED || line >= doc.lineCount) continue;
    if (!isConfident(item, highConf)) continue;

    if (item.kind === "strikeout") {
      const range = resolveMarkedRange(doc, item);
      if (!range) continue;
      const before = doc.getText(range);
      planned.push({
        id: item.id,
        label: `Delete “${clip(before, 50)}”`,
        apply: (edit, uri) => edit.delete(uri, range),
      });
    } else if (
      item.kind === "replace" ||
      ((item.kind === "highlight" || item.kind === "underline") && item.comment)
    ) {
      const range = resolveMarkedRange(doc, item);
      const value = parseSuggestion(item.comment);
      if (!range || !value) continue;
      const before = doc.getText(range);
      planned.push({
        id: item.id,
        label: `Replace “${clip(before, 32)}” → “${clip(value, 32)}”`,
        apply: (edit, uri) => edit.replace(uri, range, value),
      });
    } else if (item.kind === "insert") {
      const pos = resolveInsertPosition(doc, item);
      const value = parseSuggestion(item.comment);
      if (!pos || !value) continue;
      planned.push({
        id: item.id,
        label: `Insert “${clip(value, 50)}”`,
        apply: (edit, uri) => edit.insert(uri, pos, ` ${value}`),
      });
    }
  }

  if (planned.length === 0) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no actionable, confident edits to apply."
    );
    return;
  }

  const detail = planned.map((p, i) => `${i + 1}. ${p.label}`).join("\n");
  const pick = await vscode.window.showInformationMessage(
    `Apply ${planned.length} edit(s) to ${path.basename(adocPath)}?`,
    { modal: true, detail },
    "Apply all"
  );
  if (pick !== "Apply all") return;

  const edit = new vscode.WorkspaceEdit();
  for (const p of planned) p.apply(edit, doc.uri);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage(
      "Eddie Doc: some edits overlapped and weren't applied — apply them individually."
    );
    return;
  }
  for (const p of planned) store.toggleResolved(adocPath, p.id);
  vscode.window.showInformationMessage(
    `Eddie Doc: applied ${planned.length} edit(s).`
  );
}

interface ItemRef {
  adocPath: string;
  id: string;
}

/** Accept a tree ItemNode, a bare id, or [id] (from a hover command link). */
function resolveItemRef(store: ReviewStore, arg: unknown): ItemRef | undefined {
  // Tree node: { type: 'item', item, adocPath }
  if (
    arg &&
    typeof arg === "object" &&
    (arg as any).type === "item" &&
    (arg as any).item
  ) {
    return {
      adocPath: (arg as any).adocPath,
      id: (arg as any).item.id,
    };
  }
  const id =
    typeof arg === "string"
      ? arg
      : Array.isArray(arg) && typeof arg[0] === "string"
        ? (arg[0] as string)
        : undefined;
  if (!id) return undefined;
  // Find which session owns this id.
  for (const s of store.all()) {
    if (s.items.some((i) => i.id === id)) return { adocPath: s.adocPath, id };
  }
  return undefined;
}

function jump(store: ReviewStore, dir: 1 | -1): void {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isAdocDoc(ed.document)) return;
  const session = store.get(ed.document.uri.fsPath);
  if (!session) return;
  const lines = [
    ...new Set(
      session.items
        .map((i: ReviewItem) => effectiveLine(i))
        .filter((l) => l !== UNMATCHED)
    ),
  ].sort((a, b) => a - b);
  if (lines.length === 0) return;

  const cur = ed.selection.active.line;
  let target: number | undefined;
  if (dir === 1) target = lines.find((l) => l > cur) ?? lines[0];
  else
    target =
      [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];

  const range = ed.document.lineAt(target).range;
  ed.selection = new vscode.Selection(range.start, range.start);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
