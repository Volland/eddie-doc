import * as vscode from "vscode";
import type { ReviewItem } from "../model/types.js";
import { KIND_LABEL } from "../model/types.js";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";
import { isAdocDoc } from "../util.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;
const SOURCE = "Eddie Doc";

/**
 * Publishes mapped annotations as diagnostics so they appear in the Problems
 * panel and give Code Actions something to attach to. Unresolved items use the
 * Information severity; resolved items use Hint so they fade but stay locatable.
 */
export class DiagnosticsManager {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(private readonly store: ReviewStore) {
    this.collection = vscode.languages.createDiagnosticCollection("eddieDoc");
  }

  /** Rebuild diagnostics for a document (or the active one if omitted). */
  update(doc?: vscode.TextDocument): void {
    const target =
      doc ?? vscode.window.activeTextEditor?.document ?? undefined;
    if (!target || !isAdocDoc(target)) return;
    const session = this.store.get(target.uri.fsPath);
    if (!session) {
      this.collection.set(target.uri, []);
      return;
    }
    const showResolved = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<boolean>("showResolved", true);

    const diags: vscode.Diagnostic[] = [];
    for (const item of session.items) {
      const line = effectiveLine(item);
      if (line === UNMATCHED || line >= target.lineCount) continue;
      if (item.resolved && !showResolved) continue;

      const range = target.lineAt(line).range;
      const d = new vscode.Diagnostic(
        range,
        message(item),
        item.resolved
          ? vscode.DiagnosticSeverity.Hint
          : vscode.DiagnosticSeverity.Information
      );
      d.source = SOURCE;
      // Encode the annotation id in the code so Code Actions can resolve it.
      d.code = item.id;
      if (item.resolved) d.tags = [vscode.DiagnosticTag.Unnecessary];
      diags.push(d);
    }
    this.collection.set(target.uri, diags);
  }

  /** Is this diagnostic ours? Used by the Code Action provider to filter. */
  static isOurs(d: vscode.Diagnostic): boolean {
    return d.source === SOURCE && typeof d.code === "string";
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function message(item: ReviewItem): string {
  const parts = [`[${KIND_LABEL[item.kind]}]`];
  if (item.comment) parts.push(item.comment);
  else if (item.anchoredText)
    parts.push(`“${item.anchoredText.slice(0, 80)}”`);
  if (item.author) parts.push(`— ${item.author}`);
  if (item.resolved) parts.push("(resolved)");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
