import { MarkdownView, Notice, Platform } from "obsidian";
import type EddiePlugin from "./main.js";
import * as f from "./flows.js";
import { prompt } from "./ui/modals.js";
import { isAdocPath } from "../../core/util/adoc.js";

/**
 * The command palette. Every command is a thin call into `flows.ts`, the same
 * functions the review panel's buttons use. A command that cannot do anything in
 * the current state is not offered (`checkCallback`), rather than failing with a
 * notice. The reply commands VS Code needs (reply, edit, save, cancel, delete) are
 * the panel's reply box here, so they have no palette entry.
 */
export function registerCommands(plugin: EddiePlugin): void {
  const { store } = plugin;

  // -- when a command makes sense ------------------------------------------------
  const hasReview = () => {
    const a = plugin.resolvedAdoc();
    return !!a && !!store.get(a);
  };
  const hasItem = () => !!f.currentItem(plugin);
  const hasManyMappings = () => {
    const a = plugin.resolvedAdoc();
    return !!a && store.sessionsFor(a).length > 1;
  };
  const hasReviews = () => store.documents().length > 0;
  const hasLooseSidecars = () => store.planMigration().length > 0;
  const inAdocEditor = () => {
    const v = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return !!v?.file && isAdocPath(v.file.path) && !!store.get(v.file.path);
  };
  const desktop = () => Platform.isDesktopApp;
  const running = () => !!plugin.currentOp;

  const add = (
    id: string,
    name: string,
    run: () => unknown,
    when?: () => boolean
  ) =>
    plugin.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        if (when && !when()) return false;
        if (!checking) {
          void Promise.resolve(run()).catch((e) => {
            console.error(`Eddie Doc: ${id} failed`, e);
            new Notice(`Eddie Doc: ${name} failed — ${String(e)}`, 10000);
          });
        }
        return true;
      },
    });

  add("show-panel", "Show the review panel", () => plugin.showPanel());
  add("open-review", "Open PDF review", () => f.openReview(plugin, "ask"));
  add("new-revision", "Start new review round…", () => f.openReview(plugin, "new"));
  add("add-mapping", "Add annotated PDF to current round…", () => f.openReview(plugin, "current"), hasReview);
  add("append-pdf", "Add PDFs to this mapping…", () => f.appendPdfs(plugin), hasReview);
  add("merge-mappings", "Merge mappings into this one…", () => f.mergeMappings(plugin), hasManyMappings);
  add("edit-mapping-info", "Edit round details…", () => f.editMappingInfo(plugin), hasReview);
  add("delete-mapping", "Remove this mapping…", () => f.deleteMapping(plugin), hasReview);
  add("migrate-reviews", "Move reviews into review folder…", () => f.migrateReviews(plugin), hasLooseSidecars);
  add("open-review-folder", "Open review folder", () => f.openReviewFolder(plugin));
  add("switch-review", "Switch review", () => f.switchReview(plugin), hasReviews);
  add("switch-mapping", "Switch round / mapping", () => f.switchMapping(plugin), hasManyMappings);
  add("refresh", "Re-map annotations", () => f.remapAll(plugin), hasReview);
  add("extract-annotations", "Extract annotations as AsciiDoc", () => f.extractAnnotationsToAdoc(plugin));
  add("import-pdf-from-disk", "Import a PDF from outside the vault…", () => f.importPdfFromDisk(plugin), desktop);
  add("cancel-operation", "Cancel the running operation", () => f.cancelOperation(plugin), running);

  add("next-annotation", "Next annotation", () => f.jump(plugin, 1), inAdocEditor);
  add("prev-annotation", "Previous annotation", () => f.jump(plugin, -1), inAdocEditor);
  add("toggle-resolved", "Toggle resolved", () => f.toggleResolved(plugin), hasItem);
  add("reveal-annotation", "Reveal in source", () => {
    const ref = f.currentItem(plugin);
    return ref && plugin.revealItem(ref.adocPath, ref.id);
  }, hasItem);
  add("relink", "Re-link to current cursor line", () => f.relinkToCursor(plugin), () => hasItem() && inAdocEditor());
  add("relink-pick", "Reselect source line", () => f.relinkPick(plugin), hasItem);
  add("remap-item", "Re-map this annotation", () => f.remapItem(plugin), hasItem);
  add("confirm-match", "Confirm match", () => f.confirmMatch(plugin), hasItem);
  add("apply-all-edits", "Apply all confident edits", () => f.applyAllConfident(plugin), hasReview);
  add("triage-unmatched", "Triage unmatched annotations", () => f.triageUnmatched(plugin), hasReview);
  add("preview-annotation", "Preview in PDF", () => {
    const ref = f.currentItem(plugin);
    return ref && f.previewPdf(plugin, ref.adocPath, ref.id);
  }, hasItem);

  add("export-report", "Export review report", () => f.exportReport(plugin), hasReview);
  add("stamp-pdf", "Stamp reviewed PDF", () => f.stampReviewedPdf(plugin), hasReview);
  add("anchor-source", "Anchor annotations in source", () => f.anchorSource(plugin), hasReview);
  add("strip-anchors", "Remove source anchors", () => f.stripAnchors(plugin), hasReview);

  add("set-author-name", "Set your name for replies", async () => {
    const name = await prompt(plugin.app, "Your name on replies", { value: plugin.settings.authorName });
    if (name !== undefined) await plugin.updateSettings({ authorName: name.trim() });
  });
}
