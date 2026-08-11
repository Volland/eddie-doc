import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ReviewStore } from "./model/store.js";
import { AnnotationTreeProvider } from "./ui/treeProvider.js";
import { DecorationManager } from "./ui/decorations.js";
import { DiagnosticsManager } from "./ui/diagnostics.js";
import { EddieCodeActionProvider } from "./ui/codeActions.js";
import { effectiveLine } from "./matching/mapper.js";
import {
  buildSourceIndex,
  topMatches,
  type Candidate,
} from "./matching/fuzzyMatch.js";
import type {
  MappingInfo,
  PdfRole,
  ReviewItem,
  ReviewSession,
  ReviewType,
  RevisionInfo,
} from "./model/types.js";
import {
  KIND_LABEL,
  PDF_ROLE_LABEL,
  REVIEW_TYPE_LABEL,
  mappingLabel,
  revisionLabel,
} from "./model/types.js";
import {
  DEFAULT_REVIEW_FOLDER,
  documentFolder,
  mappingReportPath,
  pdfFolder,
  type LayoutConfig,
} from "./model/layout.js";
import { resolveSourcePath } from "./model/format.js";
import { countNewlines, type ContentChange } from "./matching/posTrack.js";
import { isAdocDoc, isAdocPath } from "./util.js";
import { resolveMarkedRange, resolveInsertPosition } from "./ui/precise.js";
import { extractAnnotations, readPages } from "./pdf/extract.js";
import { anchorItems } from "./pdf/anchor.js";
import { stampPdf } from "./pdf/stamp.js";
import { annotationsToAdoc, extractedAdocPath } from "./pdf/toAdoc.js";
import { PdfPreviewPanel } from "./ui/pdfPreview.js";
import { isSessionStale, renderReport } from "./model/report.js";
import { stripMarkers } from "./source/markers.js";
import {
  ReviewCommentController,
  type ReviewComment,
} from "./ui/comments.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

function threshold(): number {
  return vscode.workspace
    .getConfiguration("eddieDoc")
    .get<number>("matchThreshold", 0.5);
}

/**
 * Where review artifacts live, from settings. An empty `reviewFolder` selects
 * the historical layout (sidecar beside the manuscript); the default keeps the
 * manuscript folder clean by putting everything under `.eddie/`.
 */
function layoutConfig(): LayoutConfig {
  return {
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    reviewFolder: vscode.workspace
      .getConfiguration("eddieDoc")
      .get<string>("reviewFolder", DEFAULT_REVIEW_FOLDER),
  };
}

/** True when the annotated PDF should be copied in beside its mapping. */
function importPdfs(): boolean {
  return vscode.workspace
    .getConfiguration("eddieDoc")
    .get<boolean>("importPdfs", false);
}

/**
 * Resolve where a generated file belongs: inside the mapping's revision folder,
 * or beside `fallback` when the setting says so or there is no review folder.
 */
function outputPath(
  store: ReviewStore,
  session: ReviewSession,
  setting: "stampOutput" | "reportOutput",
  fallback: string,
  kind: "pdf" | "report"
): string {
  const mode = vscode.workspace
    .getConfiguration("eddieDoc")
    .get<string>(setting, "reviewFolder");
  if (mode !== "reviewFolder") return fallback;
  const folder = documentFolder(store.layoutConfig, session.adocPath);
  if (!folder) return fallback;
  if (kind === "report") {
    return mappingReportPath(folder, session.revision.id, session.mapping.id);
  }
  return path.join(
    pdfFolder(folder, session.revision.id),
    path.basename(fallback)
  );
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
  store.configure(layoutConfig());
  // Embeddings for the semantic fallback survive restarts in global storage.
  store.useEmbedCacheFile(
    path.join(context.globalStorageUri.fsPath, "embed-cache.json")
  );
  const decorations = new DecorationManager(store);
  const diagnostics = new DiagnosticsManager(store);
  const comments = new ReviewCommentController(store);
  const preview = new PdfPreviewPanel(context.extensionUri);

  // The last .adoc the user focused. When they navigate to a non-.adoc editor
  // (the tree, a PDF, settings…) we keep showing this pair rather than jumping
  // to whichever review was most recently edited.
  let lastAdoc: string | undefined = activeAdocPath();
  // Which mapping the PDF preview is currently following, so we only re-point it
  // when the shown mapping actually changes (not on every store mutation).
  // Keyed by sidecar, not document: switching rounds swaps the PDF too.
  let previewedMapping: string | undefined;

  // The pair the whole UI is bound to: the live active editor if it's an .adoc,
  // otherwise the last one we saw.
  const resolvedAdoc = (): string | undefined => activeAdocPath() ?? lastAdoc;

  const tree = new AnnotationTreeProvider(store, resolvedAdoc);

  const treeView = vscode.window.createTreeView("eddieDoc.annotations", {
    treeDataProvider: tree,
  });

  // Always-visible statement of the active triangle (source ⇄ PDF); clicking
  // it opens the review switcher.
  const pairStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90
  );
  pairStatus.command = "eddieDoc.switchReview";
  context.subscriptions.push(pairStatus);

  /** Show `id`'s PDF region and remember which mapping the preview follows. */
  const showPreview = (adocPath: string, id: string): void => {
    previewItem(store, preview, adocPath, id);
    previewedMapping = store.get(adocPath)?.sidecarPath;
  };

  // Once the preview panel is open, follow the tree selection so browsing the
  // annotation list re-renders the matching PDF region live.
  treeView.onDidChangeSelection((e) => {
    if (!preview.isOpen) return;
    const node = e.selection[0];
    if (node && node.type === "item") {
      showPreview(node.adocPath, node.item.id);
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

  // Load persisted sidecars for already-open .adoc documents up front, then scan
  // the rest of the workspace so every (.adoc, .pdf) pair is known and switchable
  // before the user has opened each source file.
  for (const doc of vscode.workspace.textDocuments) {
    if (isAdocDoc(doc)) store.tryLoadSidecar(doc.uri.fsPath);
  }
  void loadWorkspaceSidecars(store).then(refreshUI);

  /**
   * Keep the tree header and PDF preview bound to the active pair: show its name
   * next to the view title, expose whether >1 review exists (for the Switch
   * button), and — when the preview is open — re-point it at the newly active
   * pair as the user moves between .adoc files.
   */
  function syncActivePair(): void {
    const adoc = resolvedAdoc();
    const session = adoc ? store.get(adoc) : undefined;
    const pdfName = session?.pdfPath ? path.basename(session.pdfPath) : "";
    const pdfMissing =
      !!session?.pdfPath && !fs.existsSync(session.pdfPath);
    // With rounds in play, the mapping matters more than the PDF's file name:
    // "rev-2 · acme" is what tells the author which marks they are looking at.
    const round = session
      ? `r${session.revision.ordinal} · ${mappingLabel(session)}`
      : "";
    treeView.description = session
      ? `${path.basename(session.adocPath)} ⇄ ${round}${pdfMissing ? " (PDF missing)" : ""}`
      : undefined;
    if (session && adoc) {
      const open = session.items.filter((i) => !i.resolved).length;
      const siblings = store.sessionsFor(adoc);
      pairStatus.text = `$(comment-discussion) ${path.basename(
        session.adocPath
      )} ⇄ ${round}${pdfMissing ? " $(warning)" : ""}`;
      pairStatus.tooltip =
        `Eddie Doc — ${revisionLabel(session.revision)} · ${mappingLabel(session)}\n` +
        `${session.items.length} annotation(s), ${open} open\n` +
        `PDF: ${pdfName} (${PDF_ROLE_LABEL[session.pdf?.role ?? "annotated"]})` +
        (pdfMissing ? ` — NOT FOUND at ${session.pdfPath}` : "") +
        (siblings.length > 1
          ? `\n${siblings.length} mappings across ${
              store.revisionsFor(adoc).length
            } round(s)`
          : "") +
        `\nClick to switch review.`;
      pairStatus.show();
    } else {
      pairStatus.hide();
    }
    void vscode.commands.executeCommand(
      "setContext",
      "eddieDoc.hasMultipleReviews",
      store.documents().length > 1
    );
    // Only a document with more than one mapping has anything to switch between.
    void vscode.commands.executeCommand(
      "setContext",
      "eddieDoc.hasRounds",
      !!adoc && store.sessionsFor(adoc).length > 1
    );
    if (
      session &&
      adoc &&
      preview.isOpen &&
      session.sidecarPath !== previewedMapping
    ) {
      const first = session.items[0];
      if (first) showPreview(adoc, first.id);
    }
  }

  let treeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshUI() {
    tree.refresh();
    decorations.update(vscode.window.activeTextEditor);
    diagnostics.update(vscode.window.activeTextEditor?.document);
    comments.refresh();
    syncActivePair();
  }
  context.subscriptions.push(store.onDidChange(refreshUI));

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      // Focus moving off the text editors — into a comment thread's reply box, a
      // webview, the terminal — changes nothing we render, and refreshing there
      // would re-point the PDF preview and steal the focus straight back.
      if (!ed) return;
      if (isAdocDoc(ed.document)) {
        lastAdoc = ed.document.uri.fsPath;
        store.tryLoadSidecar(lastAdoc);
      }
      refreshUI();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("eddieDoc")) return;
      // Moving the review folder changes where new mappings are written and
      // where discovery looks; already-loaded ones keep their own paths.
      store.configure(layoutConfig());
      if (e.affectsConfiguration("eddieDoc.reviewFolder")) {
        void loadWorkspaceSidecars(store).then(refreshUI);
      }
      // Only decided when a thread is first created, so reconciling would not
      // show it: rebuild so the toggle lands immediately.
      if (e.affectsConfiguration("eddieDoc.expandThreads")) comments.rebuildAll();
      refreshUI();
    }),
    // Re-map on save so annotation positions stay correct after edits (e.g.
    // after inserting a note line, which shifts everything below it).
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      // Every round maps into the same text, so an edit invalidates all of
      // them — re-map the lot, not just the one currently on screen.
      if (isAdocDoc(doc) && store.get(doc.uri.fsPath)) {
        await store.remapAll(doc.uri.fsPath, threshold());
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
    vscode.commands.registerCommand(
      "eddieDoc.openReview",
      async (arg?: vscode.Uri) => {
        await openReview(store, arg, "ask");
      }
    ),

    // Explicit entry points for the two things "open a PDF" can mean once a
    // document has history: another editor's marks on the round in progress, or
    // the start of the next round.
    vscode.commands.registerCommand("eddieDoc.addMapping", async () => {
      await openReview(store, undefined, "current");
    }),

    vscode.commands.registerCommand("eddieDoc.newRevision", async () => {
      await openReview(store, undefined, "new");
    }),

    // Show one of the document's other mappings (from the tree or the picker).
    vscode.commands.registerCommand(
      "eddieDoc.activateMapping",
      async (arg?: unknown) => {
        const sidecar = sidecarArg(arg);
        if (!sidecar) return;
        const session = store.getBySidecar(sidecar);
        if (!session) return;
        store.setActive(sidecar);
        if (activeAdocPath() !== session.adocPath) {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(session.adocPath)
          );
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      }
    ),

    // Walk the document's rounds and mappings, and switch to one.
    vscode.commands.registerCommand("eddieDoc.switchMapping", async () => {
      await switchMapping(store);
    }),

    // Metadata the sidecar carries about the round and the marks in it.
    vscode.commands.registerCommand("eddieDoc.editMappingInfo", async (arg?: unknown) => {
      await editMappingInfo(store, sidecarArg(arg));
    }),

    vscode.commands.registerCommand("eddieDoc.deleteMapping", async (arg?: unknown) => {
      await deleteMapping(store, sidecarArg(arg));
    }),

    // Relocate sidecars that still sit beside the manuscript.
    vscode.commands.registerCommand("eddieDoc.migrateReviews", async () => {
      await migrateReviews(store);
    }),

    vscode.commands.registerCommand("eddieDoc.openReviewFolder", async () => {
      await openReviewFolder(store);
    }),

    // Jump the whole UI (tree, editor, and — if open — the PDF preview) to
    // another (.adoc, .pdf) pair in the project. Opening the .adoc drives the
    // active-editor sync so everything follows.
    vscode.commands.registerCommand("eddieDoc.switchReview", async () => {
      await switchReview(store);
    }),

    vscode.commands.registerCommand("eddieDoc.refresh", async () => {
      const adocPath = resolveTargetAdoc(store);
      if (!adocPath || !store.get(adocPath)) {
        vscode.window.showInformationMessage(
          "Eddie Doc: no review loaded to re-map."
        );
        return;
      }
      const n = await store.remapAll(adocPath, threshold());
      if (n > 1) {
        vscode.window.showInformationMessage(
          `Eddie Doc: re-mapped ${n} mappings across ${
            store.revisionsFor(adocPath).length
          } round(s).`
        );
      }
    }),

    vscode.commands.registerCommand(
      "eddieDoc.extractAnnotations",
      async (arg?: vscode.Uri) => {
        await extractAnnotationsToAdoc(arg);
      }
    ),

    // --- reply threads (VS Code Comments API) ---
    // The reply box hands us the thread plus the typed text; the thread's first
    // comment carries the sidecar item id.
    vscode.commands.registerCommand(
      "eddieDoc.addReply",
      (reply: vscode.CommentReply) => {
        const head = reply.thread.comments[0] as ReviewComment | undefined;
        if (!head) return;
        store.addReply(head.adocPath, head.itemId, authorName(), reply.text);
      }
    ),

    // Editing happens in the thread itself, not in a modal prompt: the reply is
    // read in context, so it should be rewritten in context too.
    vscode.commands.registerCommand(
      "eddieDoc.editReply",
      (comment: ReviewComment) => comments.beginEdit(comment)
    ),

    vscode.commands.registerCommand(
      "eddieDoc.saveReply",
      (comment: ReviewComment) => comments.finishEdit(comment)
    ),

    vscode.commands.registerCommand(
      "eddieDoc.cancelReply",
      (comment: ReviewComment) => comments.cancelEdit(comment)
    ),

    vscode.commands.registerCommand(
      "eddieDoc.deleteReply",
      async (comment: ReviewComment) => {
        if (!comment?.replyId) return;
        const pick = await vscode.window.showWarningMessage(
          "Delete this reply?",
          { modal: true },
          "Delete"
        );
        if (pick !== "Delete") return;
        store.deleteReply(comment.adocPath, comment.itemId, comment.replyId);
      }
    ),

    vscode.commands.registerCommand("eddieDoc.stampPdf", async () => {
      await stampReviewedPdf(store, preview);
    }),

    vscode.commands.registerCommand("eddieDoc.anchorSource", async () => {
      await anchorSource(store);
    }),

    vscode.commands.registerCommand("eddieDoc.stripAnchors", async () => {
      await stripSourceAnchors(store);
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

    // Walk every unmatched annotation in one pass, each with a ranked shortlist
    // of candidate source lines to link (or skip) without cursor-hunting.
    vscode.commands.registerCommand("eddieDoc.triageUnmatched", async () => {
      await triageUnmatched(store, showPreview);
    }),

    // Open (or update) the PDF preview showing this annotation's page + mark.
    vscode.commands.registerCommand(
      "eddieDoc.previewAnnotation",
      async (arg?: unknown) => {
        const ref = resolveItemRef(store, arg);
        if (!ref) return;
        showPreview(ref.adocPath, ref.id);
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
    ),

    // Write the session as a Markdown report next to the sidecar — the
    // artifact an author sends back to the editor after a review pass.
    vscode.commands.registerCommand("eddieDoc.exportReport", async () => {
      const adocPath = resolveTargetAdoc(store);
      const session = adocPath ? store.get(adocPath) : undefined;
      if (!adocPath || !session) {
        vscode.window.showInformationMessage(
          "Eddie Doc: no review loaded to export."
        );
        return;
      }
      const cfg = vscode.workspace.getConfiguration("eddieDoc");
      const md = renderReport(session, {
        highConfidence: cfg.get<number>("highConfidence", 0.75),
        stale: isSessionStale(session),
        generatedAt: new Date().toISOString(),
      });
      const outPath = outputPath(
        store,
        session,
        "reportOutput",
        adocPath.replace(/\.adoc$/i, "") + ".review.md",
        "report"
      );
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, md, "utf8");
      } catch (e) {
        vscode.window.showErrorMessage(
          `Eddie Doc: could not write report — ${String(e)}`
        );
        return;
      }
      store.recordArtifact(session.sidecarPath, {
        kind: "report",
        path: outPath,
        createdAt: new Date().toISOString(),
      });
      const doc = await vscode.workspace.openTextDocument(outPath);
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() =>
      decorations.update(vscode.window.activeTextEditor)
    ),
    treeView,
    decorations,
    diagnostics,
    comments,
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

/** Filename stem used to compare a PDF against candidate .adoc sources. */
function pairStem(file: string): string {
  return path
    .basename(file)
    .replace(/(\.annotated)?\.pdf$/i, "")
    .replace(/\.(adoc|asciidoc)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Catch the classic mistake of picking another chapter's PDF: when the chosen
 * PDF's name disagrees with the .adoc but exactly matches a different source
 * file in the workspace, offer to bind the review to that file instead.
 * Returns the (possibly re-bound) pair, or undefined if the user backs out.
 */
async function confirmPairSanity(
  pair: ReviewPair
): Promise<ReviewPair | undefined> {
  const pdfStem = pairStem(pair.pdfPath);
  const adocStem = pairStem(pair.adocPath);
  if (
    !pdfStem ||
    !adocStem ||
    pdfStem.includes(adocStem) ||
    adocStem.includes(pdfStem)
  ) {
    return pair;
  }

  let better: string | undefined;
  try {
    const hits = await vscode.workspace.findFiles(
      "**/*.{adoc,asciidoc}",
      "**/node_modules/**"
    );
    const exact = hits.filter((u) => pairStem(u.fsPath) === pdfStem);
    if (exact.length === 1) better = exact[0].fsPath;
  } catch {
    /* no workspace — nothing to suggest */
  }
  if (!better || better === pair.adocPath) return pair;

  const useBetter = `Use ${path.basename(better)}`;
  const keep = `Keep ${path.basename(pair.adocPath)}`;
  const choice = await vscode.window.showWarningMessage(
    `"${path.basename(pair.pdfPath)}" looks like the PDF for ` +
      `"${path.basename(better)}", not "${path.basename(pair.adocPath)}". ` +
      `Map its annotations onto which source?`,
    { modal: true },
    useBetter,
    keep
  );
  if (!choice) return undefined;
  return choice === useBetter
    ? { adocPath: better, pdfPath: pair.pdfPath }
    : pair;
}

// ---- Rounds and mappings --------------------------------------------------

/**
 * Which round a newly opened PDF joins.
 *
 * - `ask` — let the user say (only asked once the document has history).
 * - `current` — another editor's marks on the round already in progress.
 * - `new` — the next round.
 */
type OpenMode = "ask" | "current" | "new";

/**
 * Map an annotated PDF onto a source document as one mapping of one round.
 *
 * A document accumulates mappings: several per round when the marks came back
 * from several places, and a fresh set each round. Everything the flow needs to
 * know beyond the two files — which round, whose marks — is asked for only when
 * the document already has history, so a first review is the same two clicks it
 * always was.
 */
async function openReview(
  store: ReviewStore,
  arg: vscode.Uri | undefined,
  mode: OpenMode
): Promise<void> {
  let pair = await resolveReviewPair(store, arg);
  if (!pair) return;
  pair = await confirmPairSanity(pair);
  if (!pair) return;
  const { adocPath, pdfPath } = pair;

  // Know the document's full history before deciding what this PDF is part of.
  store.tryLoadSidecar(adocPath);
  const existing = store.sessionsFor(adocPath);

  const revision = await chooseRevision(store, adocPath, mode, existing);
  if (!revision) return;

  // Re-opening the same PDF in the same round refreshes that mapping in place
  // instead of leaving a second copy of it beside the first.
  const rebind = existing.find(
    (s) =>
      s.revision.id === revision.id &&
      s.pdfPath &&
      (path.resolve(s.pdfPath) === path.resolve(pdfPath) ||
        (s.pdf?.importedFrom &&
          path.resolve(s.pdf.importedFrom) === path.resolve(pdfPath)))
  );

  const mapping = existing.length
    ? await promptMappingMeta(pdfPath, rebind?.mapping)
    : {};

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: rebind
        ? "Eddie Doc: re-mapping PDF annotations…"
        : "Eddie Doc: mapping PDF annotations…",
    },
    async () => {
      try {
        const session = await store.loadReview(adocPath, pdfPath, {
          threshold: threshold(),
          revision,
          sidecarPath: rebind?.sidecarPath,
          mapping,
          pdfRole: rebind?.pdf?.role ?? "annotated",
          importPdf: importPdfs(),
        });
        const matched = session.items.filter(
          (i) => effectiveLine(i) !== UNMATCHED
        ).length;
        vscode.window.showInformationMessage(
          `Eddie Doc: ${revisionLabel(session.revision)} · ${mappingLabel(
            session
          )} — ${session.items.length} annotation(s), ${matched} mapped to source.`
        );
        // A mostly-unmatched review usually means the PDF belongs to a
        // different source file — say so instead of leaving a dead tree.
        if (session.items.length >= 5 && matched / session.items.length < 0.4) {
          vscode.window.showWarningMessage(
            `Eddie Doc: only ${matched} of ${session.items.length} annotations mapped. ` +
              `Check that "${path.basename(pdfPath)}" is really the annotated PDF for ` +
              `"${path.basename(adocPath)}", then use Triage for the rest.`
          );
        }
        // Bind the whole UI to the reviewed source (it may differ from the
        // active editor when the pair was re-bound or launched from a PDF).
        if (activeAdocPath() !== adocPath) {
          await vscode.window.showTextDocument(vscode.Uri.file(adocPath), {
            preview: false,
          });
        }
        await vscode.commands.executeCommand("eddieDoc.annotations.focus");
      } catch (e) {
        vscode.window.showErrorMessage(
          `Eddie Doc: failed to read PDF — ${String(e)}`
        );
      }
    }
  );
}

interface RevisionPick extends vscode.QuickPickItem {
  revision: RevisionInfo;
}

/** Decide the round a PDF joins; undefined when the user backs out. */
async function chooseRevision(
  store: ReviewStore,
  adocPath: string,
  mode: OpenMode,
  existing: ReviewSession[]
): Promise<RevisionInfo | undefined> {
  // Nothing to choose between on a document's first review.
  if (!existing.length) return store.nextRevision(adocPath);
  if (mode === "new") return store.nextRevision(adocPath);
  if (mode === "current")
    return store.latestRevision(adocPath) ?? store.nextRevision(adocPath);

  const next = store.nextRevision(adocPath);
  const picks: RevisionPick[] = [];
  for (const rev of store.revisionsFor(adocPath).slice().reverse()) {
    const inRound = existing.filter((s) => s.revision.id === rev.id);
    picks.push({
      label: `$(git-commit) ${revisionLabel(rev)}`,
      description:
        rev.ordinal === (store.latestRevision(adocPath)?.ordinal ?? 0)
          ? "current round"
          : "",
      detail: `Add these marks alongside ${inRound
        .map((s) => mappingLabel(s))
        .join(", ")}`,
      revision: rev,
    });
  }
  picks.unshift({
    label: `$(add) Start ${revisionLabel(next)}`,
    detail:
      "A new round of edits. Resolved state, notes and replies carry over " +
      "from the previous round by annotation content.",
    revision: next,
  });

  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Which round do these marks belong to? — ${path.basename(adocPath)}`,
    placeHolder: "Start a new round, or add to one already open",
  });
  return chosen?.revision;
}

/**
 * Ask who the marks came from. Deliberately skippable: Escape keeps the
 * defaults and proceeds rather than throwing away the PDF the user just picked.
 */
async function promptMappingMeta(
  pdfPath: string,
  previous?: MappingInfo
): Promise<Partial<MappingInfo>> {
  const suggestion =
    previous?.origin ??
    path
      .basename(pdfPath)
      .replace(/\.pdf$/i, "")
      .replace(/[._-]+/g, " ")
      .trim();
  const origin = await vscode.window.showInputBox({
    title: "Where did these marks come from?",
    prompt:
      "Publisher, agency or reviewer — shown on the round in the sidebar. " +
      "Press Escape to skip.",
    value: suggestion,
    valueSelection: [0, suggestion.length],
  });
  if (origin == null) return {};
  const trimmed = origin.trim();
  return trimmed ? { origin: trimmed, label: trimmed } : {};
}

interface MappingPick extends vscode.QuickPickItem {
  sidecarPath?: string;
}

/** Switch the view between the rounds and mappings of the active document. */
async function switchMapping(store: ReviewStore): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const sessions = adocPath ? store.sessionsFor(adocPath) : [];
  if (!adocPath || !sessions.length) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no review loaded for this document."
    );
    return;
  }
  const active = store.get(adocPath);
  const picks: MappingPick[] = [];
  let lastRevision = "";
  for (const s of sessions.slice().reverse()) {
    if (s.revision.id !== lastRevision) {
      lastRevision = s.revision.id;
      picks.push({
        label: revisionLabel(s.revision),
        kind: vscode.QuickPickItemKind.Separator,
      });
    }
    const open = s.items.filter((i) => !i.resolved).length;
    const matched = s.items.filter((i) => effectiveLine(i) !== UNMATCHED).length;
    picks.push({
      label: `${s.sidecarPath === active?.sidecarPath ? "$(circle-filled)" : "$(circle-outline)"} ${mappingLabel(s)}`,
      description: `${matched}/${s.items.length} mapped · ${open} open · ${PDF_ROLE_LABEL[
        s.pdf?.role ?? "annotated"
      ].toLowerCase()} PDF`,
      detail: s.mapping.reviewType
        ? REVIEW_TYPE_LABEL[s.mapping.reviewType]
        : undefined,
      sidecarPath: s.sidecarPath,
    });
  }
  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Rounds of ${path.basename(adocPath)}`,
    placeHolder: "Choose the round / mapping to show",
  });
  if (!chosen?.sidecarPath) return;
  await vscode.commands.executeCommand(
    "eddieDoc.activateMapping",
    chosen.sidecarPath
  );
}

/**
 * Edit the metadata a mapping carries: which round it is, who marked it up,
 * what kind of pass it was, and what kind of PDF it came from. One field per
 * pass through the picker, so the flow is escapable at every point.
 */
async function editMappingInfo(
  store: ReviewStore,
  sidecarPath?: string
): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const session = sidecarPath
    ? store.getBySidecar(sidecarPath)
    : adocPath
      ? store.get(adocPath)
      : undefined;
  if (!session) {
    vscode.window.showInformationMessage("Eddie Doc: no review loaded.");
    return;
  }

  interface FieldPick extends vscode.QuickPickItem {
    field: string;
  }
  for (;;) {
    const m = session.mapping;
    const fields: FieldPick[] = [
      {
        field: "revisionLabel",
        label: "$(git-commit) Round label",
        description: session.revision.label ?? `Revision ${session.revision.ordinal}`,
      },
      {
        field: "receivedAt",
        label: "$(calendar) Received",
        description: session.revision.receivedAt?.slice(0, 10) ?? "—",
      },
      { field: "origin", label: "$(organization) From", description: m.origin ?? "—" },
      { field: "reviewer", label: "$(account) Reviewer", description: m.reviewer ?? "—" },
      {
        field: "reviewType",
        label: "$(checklist) Kind of review",
        description: m.reviewType ? REVIEW_TYPE_LABEL[m.reviewType] : "—",
      },
      {
        field: "pdfRole",
        label: "$(file-pdf) Kind of PDF",
        description: PDF_ROLE_LABEL[session.pdf?.role ?? "annotated"],
      },
      {
        field: "note",
        label: "$(note) Round note",
        description: session.revision.note ?? "—",
      },
    ];
    const chosen = await vscode.window.showQuickPick(fields, {
      title: `${revisionLabel(session.revision)} · ${mappingLabel(session)}`,
      placeHolder: "Choose a field to edit — Escape when done",
    });
    if (!chosen) return;

    if (chosen.field === "reviewType") {
      const kinds = Object.entries(REVIEW_TYPE_LABEL).map(([value, label]) => ({
        label,
        value: value as ReviewType,
      }));
      const pick = await vscode.window.showQuickPick(kinds, {
        title: "Kind of review",
      });
      if (pick) store.describeMapping(session.sidecarPath, { reviewType: pick.value });
      continue;
    }
    if (chosen.field === "pdfRole") {
      const roles = Object.entries(PDF_ROLE_LABEL).map(([value, label]) => ({
        label,
        value: value as PdfRole,
        description:
          value === "annotated"
            ? "Came back from an editor with marks on it"
            : value === "clean"
              ? "A fresh render with no review markup"
              : undefined,
      }));
      const pick = await vscode.window.showQuickPick(roles, {
        title: "What kind of PDF is mapped?",
      });
      if (pick) store.describeMapping(session.sidecarPath, { pdfRole: pick.value });
      continue;
    }

    const current =
      chosen.field === "revisionLabel"
        ? (session.revision.label ?? "")
        : chosen.field === "receivedAt"
          ? (session.revision.receivedAt?.slice(0, 10) ?? "")
          : chosen.field === "note"
            ? (session.revision.note ?? "")
            : ((session.mapping as unknown as Record<string, unknown>)[
                chosen.field
              ] as string | undefined) ?? "";
    const value = await vscode.window.showInputBox({
      title: chosen.label.replace(/^\$\([a-z-]+\)\s*/, ""),
      value: current,
      prompt:
        chosen.field === "receivedAt"
          ? "Date the round came back, as YYYY-MM-DD"
          : undefined,
    });
    if (value == null) continue;
    const text = value.trim();
    if (chosen.field === "revisionLabel") {
      store.describeMapping(session.sidecarPath, {
        revision: { label: text || undefined },
      });
    } else if (chosen.field === "receivedAt") {
      store.describeMapping(session.sidecarPath, {
        revision: { receivedAt: text || undefined },
      });
    } else if (chosen.field === "note") {
      store.describeMapping(session.sidecarPath, {
        revision: { note: text || undefined },
      });
    } else {
      store.describeMapping(session.sidecarPath, { [chosen.field]: text || undefined });
    }
  }
}

/** Drop one mapping, leaving the manuscript, the PDF and its report alone. */
async function deleteMapping(
  store: ReviewStore,
  sidecarPath?: string
): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const session = sidecarPath
    ? store.getBySidecar(sidecarPath)
    : adocPath
      ? store.get(adocPath)
      : undefined;
  if (!session) return;
  const pick = await vscode.window.showWarningMessage(
    `Remove ${revisionLabel(session.revision)} · ${mappingLabel(session)}?`,
    {
      modal: true,
      detail:
        `Deletes ${path.basename(session.sidecarPath)} and the review state in ` +
        `it — resolved marks, notes and replies for this mapping. The ` +
        `manuscript, the PDF and any exported report are left alone.`,
    },
    "Remove"
  );
  if (pick !== "Remove") return;
  if (store.deleteMapping(session.sidecarPath)) {
    vscode.window.showInformationMessage(
      `Eddie Doc: removed ${mappingLabel(session)}.`
    );
  }
}

/** Move sidecars that still sit beside a manuscript into the review folder. */
async function migrateReviews(store: ReviewStore): Promise<void> {
  if (!store.layoutConfig.reviewFolder.trim()) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no review folder configured — set eddieDoc.reviewFolder first."
    );
    return;
  }
  await loadWorkspaceSidecars(store);
  const steps = store.planMigration();
  if (!steps.length) {
    vscode.window.showInformationMessage(
      "Eddie Doc: every review already lives in the review folder."
    );
    return;
  }
  const root = store.layoutConfig.workspaceRoot;
  const show = (p: string) => (root ? path.relative(root, p) : path.basename(p));
  const listed = steps.slice(0, 12).map((s) => `${show(s.from)}  →  ${show(s.to)}`);
  if (steps.length > listed.length)
    listed.push(`…and ${steps.length - listed.length} more`);

  const pick = await vscode.window.showInformationMessage(
    `Move ${steps.length} review file(s) into the review folder?`,
    {
      modal: true,
      detail:
        listed.join("\n") +
        "\n\nThe manuscript files are not touched. Each sidecar is rewritten " +
        "at its new location so the paths inside stay relative and portable.",
    },
    "Move"
  );
  if (pick !== "Move") return;

  const res = store.migrate(steps);
  if (res.failed.length) {
    vscode.window.showWarningMessage(
      `Eddie Doc: moved ${res.moved}, failed ${res.failed.length} — ${res.failed[0]}`
    );
  } else {
    vscode.window.showInformationMessage(
      `Eddie Doc: moved ${res.moved} review file(s) into the review folder.`
    );
  }
}

/** Reveal the active document's folder in the review tree. */
async function openReviewFolder(store: ReviewStore): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const folder = adocPath
    ? documentFolder(store.layoutConfig, adocPath)
    : undefined;
  if (!folder) {
    vscode.window.showInformationMessage(
      "Eddie Doc: reviews are stored beside the manuscript — set " +
        "eddieDoc.reviewFolder to keep them in their own folder."
    );
    return;
  }
  if (!fs.existsSync(folder)) {
    vscode.window.showInformationMessage(
      `Eddie Doc: nothing stored yet for ${path.basename(adocPath!)}.`
    );
    return;
  }
  await vscode.commands.executeCommand(
    "revealFileInOS",
    vscode.Uri.file(folder)
  );
}

/** Accept a sidecar path, or the tree's mapping node, from a command argument. */
function sidecarArg(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object") {
    const node = arg as { type?: string; session?: { sidecarPath?: string } };
    if (node.type === "mapping" && node.session?.sidecarPath)
      return node.session.sidecarPath;
  }
  return undefined;
}

/**
 * Discover every persisted review in the workspace by its `.review.json` sidecar
 * and load it, so all rounds are known (and switchable) without first opening
 * each .adoc.
 *
 * A sidecar under the review folder no longer sits next to the document it
 * describes, so the source is taken from the path recorded inside it; only a
 * legacy sidecar still falls back to name-matching against its neighbours.
 */
async function loadWorkspaceSidecars(store: ReviewStore): Promise<void> {
  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles(
      "**/*.review.json",
      "**/node_modules/**"
    );
  } catch {
    return;
  }
  for (const f of files) {
    if (store.getBySidecar(f.fsPath)) continue;
    let adoc: string | undefined;
    try {
      adoc = resolveSourcePath(fs.readFileSync(f.fsPath, "utf8"), f.fsPath);
    } catch {
      continue;
    }
    if (!adoc || !isAdocPath(adoc) || !fs.existsSync(adoc)) {
      // Pre-v2 sidecar: its source is named by the file itself.
      const base = f.fsPath.replace(/\.review\.json$/i, "");
      adoc = [base, base + ".adoc", base + ".asciidoc"].find(
        (p) => isAdocPath(p) && fs.existsSync(p)
      );
    }
    if (adoc) store.loadSidecarFile(f.fsPath, adoc);
  }
}

/**
 * Pick a reviewed document and open it so the tree/editor/preview follow. One
 * row per document — its rounds are then switched between with
 * {@link switchMapping}, which keeps this list the size of the manuscript rather
 * than the size of its review history.
 */
async function switchReview(store: ReviewStore): Promise<void> {
  const docs = store.documents();
  if (docs.length === 0) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no reviews loaded — run 'Open PDF Review' first."
    );
    return;
  }

  interface Pick extends vscode.QuickPickItem {
    adocPath: string;
  }
  const picks: Pick[] = docs
    .map((adocPath) => {
      const sessions = store.sessionsFor(adocPath);
      const active = store.get(adocPath);
      const rounds = store.revisionsFor(adocPath).length;
      const open = sessions.reduce(
        (n, s) => n + s.items.filter((i) => !i.resolved).length,
        0
      );
      const total = sessions.reduce((n, s) => n + s.items.length, 0);
      return {
        label: path.basename(adocPath),
        description:
          `${open} open of ${total} · ${rounds} round(s)` +
          (sessions.length > rounds ? ` · ${sessions.length} mappings` : ""),
        detail: active
          ? `showing ${revisionLabel(active.revision)} · ${mappingLabel(active)}`
          : undefined,
        adocPath,
        updatedAt: sessions
          .map((s) => s.updatedAt)
          .sort()
          .pop() ?? "",
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const chosen = await vscode.window.showQuickPick(picks, {
    title: "Switch review",
    placeHolder: "Choose the document to review",
  });
  if (!chosen) return;

  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(chosen.adocPath)
  );
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand("eddieDoc.annotations.focus");
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

// ---- Unmatched batch triage ----------------------------------------------

/** How many ranked candidate lines to surface per unmatched item. */
const TRIAGE_CANDIDATES = 6;

type TriageAction =
  | { type: "link"; line: number }
  | { type: "skip" }
  | { type: "abort" };

interface TriagePick extends vscode.QuickPickItem {
  /** Absent on separator rows. */
  line?: number;
}

const TRIAGE_SKIP: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("arrow-right"),
  tooltip: "Skip — leave this one unmatched",
};
const TRIAGE_PREVIEW: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("file-media"),
  tooltip: "Preview this annotation in the PDF",
};

/**
 * Resolve the Unmatched pile in a single keyboard-driven pass. For each
 * unmatched annotation we show a QuickPick whose top rows are the best-scoring
 * candidate source lines (from {@link topMatches}) with the strongest
 * pre-selected — Enter links it and auto-advances, the → button skips, Escape
 * stops. Below the suggestions the full line list is available for free search,
 * exactly like the single-item Reselect flow. Unlike Reselect, one invocation
 * clears the whole backlog.
 */
async function triageUnmatched(
  store: ReviewStore,
  showPreview: (adocPath: string, id: string) => void
): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const session = adocPath ? store.get(adocPath) : undefined;
  if (!adocPath || !session) {
    vscode.window.showInformationMessage("Eddie Doc: no review loaded.");
    return;
  }

  // Snapshot the current unmatched, unresolved items up front — linking mutates
  // the session as we go, so we iterate over ids captured now.
  const queue = session.items.filter(
    (i) => !i.resolved && effectiveLine(i) === UNMATCHED
  );
  if (queue.length === 0) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no unmatched annotations to triage."
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const idx = buildSourceIndex(doc.getText());
  const lineText = (n: number) => doc.lineAt(n).text.trim();

  let linked = 0;
  let skipped = 0;

  for (let qi = 0; qi < queue.length; qi++) {
    const snapshot = queue[qi];
    // The item may have been resolved/linked by an earlier step in this run.
    const item = store.findItem(adocPath, snapshot.id);
    if (!item || item.resolved || effectiveLine(item) !== UNMATCHED) continue;

    const anchorRaw = item.anchoredText || item.comment || "";
    const anchor = anchorRaw.replace(/\s+/g, " ").trim();
    const cands = topMatches(anchorRaw, idx, TRIAGE_CANDIDATES);

    const action = await triageOne(
      doc,
      item,
      anchor,
      cands,
      lineText,
      qi + 1,
      queue.length,
      () => showPreview(adocPath, item.id)
    );

    if (action.type === "abort") break;
    if (action.type === "skip") {
      skipped++;
      continue;
    }
    // link
    store.relink(adocPath, item.id, action.line);
    linked++;
    const range = doc.lineAt(Math.min(action.line, doc.lineCount - 1)).range;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  const left = queue.length - linked - skipped;
  vscode.window.showInformationMessage(
    `Eddie Doc: triage — ${linked} linked, ${skipped} skipped` +
      (left > 0 ? `, ${left} not reached.` : ".")
  );
}

/** Present one unmatched item's shortlist; resolve to the user's choice. */
function triageOne(
  doc: vscode.TextDocument,
  item: ReviewItem,
  anchor: string,
  cands: Candidate[],
  lineText: (n: number) => string,
  position: number,
  total: number,
  onPreview: () => void
): Promise<TriageAction> {
  const candLines = new Set(cands.map((c) => c.startLine));
  const picks: TriagePick[] = [];

  if (cands.length) {
    picks.push({
      label: "Suggestions",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const c of cands) {
      picks.push({
        label: `Line ${c.startLine + 1}`,
        description: `${c.score.toFixed(2)} · ${clip(lineText(c.startLine), 90)}`,
        line: c.startLine,
      });
    }
    picks.push({
      label: "All lines",
      kind: vscode.QuickPickItemKind.Separator,
    });
  }
  for (let n = 0; n < doc.lineCount; n++) {
    if (candLines.has(n)) continue; // already shown as a suggestion
    const text = lineText(n);
    if (!text) continue;
    picks.push({
      label: `Line ${n + 1}`,
      description: clip(text, 100),
      line: n,
    });
  }

  return new Promise<TriageAction>((resolve) => {
    const qp = vscode.window.createQuickPick<TriagePick>();
    qp.title = `Triage unmatched ${position}/${total} — ${KIND_LABEL[item.kind]}`;
    qp.placeholder = anchor
      ? `“${clip(anchor, 70)}” — Enter to link the highlighted line, → to skip`
      : "Pick the source line to link this annotation to, or → to skip";
    qp.matchOnDescription = true;
    qp.items = picks;
    qp.buttons = [TRIAGE_PREVIEW, TRIAGE_SKIP];
    // Pre-highlight the strongest suggestion (first row carrying a line).
    const first = picks.find((p) => p.line != null);
    if (first) qp.activeItems = [first];

    let done = false;
    const finish = (a: TriageAction) => {
      if (done) return;
      done = true;
      resolve(a);
      qp.hide();
    };

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel && sel.line != null) finish({ type: "link", line: sel.line });
    });
    qp.onDidTriggerButton((b) => {
      if (b === TRIAGE_SKIP) finish({ type: "skip" });
      else if (b === TRIAGE_PREVIEW) onPreview();
    });
    // Dismissed (Escape) without a choice = stop the whole run.
    qp.onDidHide(() => {
      finish({ type: "abort" });
      qp.dispose();
    });
    qp.show();
  });
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
 * Write `// eddie:<id>` markers into the source above every located annotation,
 * and record the resulting anchors in the sidecar.
 *
 * This is the one command that edits the manuscript, so it is deliberately
 * explicit: loading a review and re-mapping never touch the document. The
 * rewrite goes through a single `WorkspaceEdit`, which makes it one undo step
 * and leaves the file dirty for the author to inspect before saving.
 *
 * Asciidoctor strips `//` lines in its preprocessor, so markers cannot reach
 * the rendered PDF — verified against the real chapter build, where the
 * marked and unmarked sources render byte-identical text.
 */
async function anchorSource(store: ReviewStore): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  if (!adocPath || !store.get(adocPath)) {
    vscode.window.showInformationMessage(
      "Eddie Doc: open a document with a loaded review first."
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const before = doc.getText();
  const res = store.buildAnchors(adocPath, before);
  if (!res) return;

  if (res.inserted === 0) {
    vscode.window.showInformationMessage(
      res.anchored > 0
        ? `Eddie Doc: all ${res.anchored} located annotation(s) were already anchored.`
        : "Eddie Doc: nothing to anchor — no annotation has a source location yet."
    );
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    `Anchor ${res.anchored} annotation(s) in ${path.basename(adocPath)}?`,
    {
      modal: true,
      detail:
        `${res.inserted} marker comment(s) will be added to the source.\n\n` +
        `Markers are AsciiDoc comments — they never render, and they keep ` +
        `annotations attached to their paragraph even when the text is ` +
        `rewritten outside the editor. Applied as one undoable edit.`,
    },
    "Anchor"
  );
  if (pick !== "Anchor") return;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(before.length)
    ),
    res.source
  );
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showWarningMessage("Eddie Doc: could not apply the anchors.");
    return;
  }
  // Persist the anchors the store just attached to the items.
  await store.remap(adocPath, threshold());
  vscode.window.showInformationMessage(
    `Eddie Doc: anchored ${res.anchored} annotation(s) with ${res.inserted} marker(s).`
  );
}

/**
 * Write the review onto a freshly rendered PDF, beside it as
 * `<name>.reviewed.pdf`.
 *
 * The clean render is never modified: it is the file that goes to the
 * publisher, and review markup must not be able to reach it by accident.
 */
async function stampReviewedPdf(
  store: ReviewStore,
  preview: PdfPreviewPanel
): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  const session = adocPath ? store.get(adocPath) : undefined;
  if (!adocPath || !session) {
    vscode.window.showInformationMessage(
      "Eddie Doc: open a document with a loaded review first."
    );
    return;
  }

  // Default to a sibling PDF named after the source — what build-pdf.sh emits.
  const guess = adocPath.replace(/\.adoc$/i, "") + ".pdf";
  const picked = await vscode.window.showOpenDialog({
    title: "Select the freshly generated PDF to stamp",
    canSelectMany: false,
    filters: { PDF: ["pdf"] },
    defaultUri: fs.existsSync(guess)
      ? vscode.Uri.file(guess)
      : vscode.Uri.file(path.dirname(adocPath)),
    openLabel: "Stamp",
  });
  const freshPath = picked?.[0]?.fsPath;
  if (!freshPath) return;

  // The stamped PDF is an intermediate artifact of this round, so it belongs
  // with the round — not in the manuscript folder next to the clean render.
  const outPath = outputPath(
    store,
    session,
    "stampOutput",
    freshPath.replace(/\.pdf$/i, "") + ".reviewed.pdf",
    "pdf"
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Eddie Doc: stamping review…" },
    async () => {
      const bytes = new Uint8Array(fs.readFileSync(freshPath));
      const pages = await readPages(bytes);
      const source = fs.readFileSync(adocPath, "utf8");
      const { anchored, unstamped } = anchorItems(session.items, source, pages);
      const result = await stampPdf(bytes, anchored);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, result.bytes);
      store.recordArtifact(session.sidecarPath, {
        kind: "stampedPdf",
        path: outPath,
        createdAt: new Date().toISOString(),
        note: `stamped from ${path.basename(freshPath)}`,
      });

      const summary =
        `Stamped ${result.marks} mark(s) and ${result.replies} repl(ies) into ` +
        `${path.basename(outPath)}` +
        (unstamped.length ? ` · ${unstamped.length} could not be placed` : "");
      const actions = unstamped.length ? ["Open", "Show unplaced"] : ["Open"];
      const pick = await vscode.window.showInformationMessage(summary, ...actions);
      if (pick === "Open") preview.show(outPath, 1, [], path.basename(outPath));
      else if (pick === "Show unplaced") {
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: renderUnplaced(unstamped),
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  );
}

/** A short markdown list of what could not be stamped, and why. */
function renderUnplaced(
  unstamped: Array<{ item: ReviewItem; reason: string }>
): string {
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
  return lines.join("\n") + "\n";
}

/** Remove every marker comment from the active document, as one undoable edit. */
async function stripSourceAnchors(store: ReviewStore): Promise<void> {
  const adocPath = resolveTargetAdoc(store);
  if (!adocPath) return;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(adocPath)
  );
  const before = doc.getText();
  const after = stripMarkers(before);
  if (after === before) {
    vscode.window.showInformationMessage(
      "Eddie Doc: no markers in this document."
    );
    return;
  }
  const removed = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
  const pick = await vscode.window.showInformationMessage(
    `Remove ${removed} marker comment(s) from ${path.basename(adocPath)}?`,
    {
      modal: true,
      detail:
        "Annotations will fall back to block ids, fingerprints and text " +
        "matching, so some may drift on the next re-map.",
    },
    "Remove"
  );
  if (pick !== "Remove") return;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)),
    after
  );
  await vscode.workspace.applyEdit(edit);
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

/** Cached so we shell out to git at most once per session. */
let cachedAuthor: string | undefined;

/**
 * Display name for the author's replies: the explicit setting, else the local
 * git identity, else a neutral fallback. Resolved lazily and memoized — this is
 * on the path of every reply, and `git config` is a process spawn.
 */
function authorName(): string {
  const configured = vscode.workspace
    .getConfiguration("eddieDoc")
    .get<string>("authorName", "")
    .trim();
  if (configured) return configured;
  if (cachedAuthor !== undefined) return cachedAuthor;
  try {
    cachedAuthor =
      execFileSync("git", ["config", "user.name"], {
        encoding: "utf8",
        timeout: 2000,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }).trim() || "Author";
  } catch {
    cachedAuthor = "Author"; // no git, no repo, or no configured identity
  }
  return cachedAuthor;
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
  // Find which mapping owns this id. Annotation ids repeat across rounds, so
  // locate() prefers the one on screen; a hit in another round becomes the
  // shown one, since that is where the command is about to act.
  const owner = store.locate(id);
  if (!owner) return undefined;
  if (store.get(owner.adocPath)?.sidecarPath !== owner.sidecarPath) {
    store.setActive(owner.sidecarPath);
  }
  return { adocPath: owner.adocPath, id };
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
