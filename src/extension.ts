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
import { isAdocDoc, isAdocPath } from "./util.js";
import { resolveMarkedRange, resolveInsertPosition } from "./ui/precise.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

function threshold(): number {
  return vscode.workspace
    .getConfiguration("eddieDoc")
    .get<number>("matchThreshold", 0.55);
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

  const treeView = vscode.window.createTreeView("eddieDoc.annotations", {
    treeDataProvider: tree,
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

  // Right-clicked a PDF: pair it with a sibling .adoc, else the active one.
  if (fsPath && /\.pdf$/i.test(fsPath)) {
    const adocPath = siblingAdoc(fsPath) ?? resolveTargetAdoc(store);
    if (!adocPath) {
      vscode.window.showErrorMessage(
        "Eddie Doc: open the .adoc source this PDF reviews, then try again."
      );
      return undefined;
    }
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

/** Find the .adoc that sits next to a PDF (foo.pdf / foo.annotated.pdf → foo.adoc). */
function siblingAdoc(pdfPath: string): string | undefined {
  const base = pdfPath.replace(/(\.annotated)?\.pdf$/i, "");
  for (const ext of [".adoc", ".asciidoc"]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
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
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, replacement);
  await vscode.workspace.applyEdit(edit);
  store.toggleResolved(adocPath, id);
  await revealItem(store, adocPath, id);
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
