import * as vscode from "vscode";
import type { ReviewItem } from "../model/types.js";
import { KIND_LABEL } from "../model/types.js";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";
import { DiagnosticsManager } from "./diagnostics.js";
import { resolveMarkedRange } from "./precise.js";
import { isAdocDoc } from "../util.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/**
 * Offers lightbulb actions on annotated lines. Everything here is explicit and
 * undoable — nothing runs automatically — so it stays true to the
 * navigate-and-edit-by-hand workflow while removing the busywork.
 *
 * Edits are character-precise where possible: strikeouts delete exactly the
 * struck words (aligned back through AsciiDoc markup), replacements and
 * insertions apply at the exact offset. When a precise range can't be resolved
 * confidently, whole-line fallbacks remain.
 */
export class EddieCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  constructor(private readonly store: ReviewStore) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!isAdocDoc(document)) return [];
    const session = this.store.get(document.uri.fsPath);
    if (!session) return [];
    const adocPath = document.uri.fsPath;

    const items = this.itemsForRange(session.items, range, context, document);
    if (items.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    for (const item of items) {
      actions.push(this.toggleResolvedAction(item));

      const precise = resolveMarkedRange(document, item);

      if (item.kind === "strikeout") {
        if (precise)
          actions.push(this.preciseDeleteAction(document, item, precise));
        actions.push(this.replaceCmdAction(adocPath, item, "struck"));
        actions.push(this.deleteLinesAction(document, item));
      }
      if (
        (item.kind === "highlight" || item.kind === "underline") &&
        item.comment
      ) {
        actions.push(this.replaceCmdAction(adocPath, item, "highlighted"));
      }
      if (item.kind === "insert") {
        actions.push(this.insertCmdAction(adocPath, item));
      }
      if (item.comment) actions.push(this.insertNoteAction(document, item));
    }
    return actions;
  }

  /** Annotations relevant to the cursor: matched from our diagnostics + line. */
  private itemsForRange(
    all: ReviewItem[],
    range: vscode.Range,
    context: vscode.CodeActionContext,
    document: vscode.TextDocument
  ): ReviewItem[] {
    const ids = new Set(
      context.diagnostics
        .filter(DiagnosticsManager.isOurs)
        .map((d) => String(d.code))
    );
    const seen = new Set<string>();
    const out: ReviewItem[] = [];
    for (const item of all) {
      const line = effectiveLine(item);
      if (line === UNMATCHED || line >= document.lineCount) continue;
      const onLine = line >= range.start.line && line <= range.end.line;
      if (!ids.has(item.id) && !onLine) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  private toggleResolvedAction(item: ReviewItem): vscode.CodeAction {
    const title = item.resolved
      ? `Eddie Doc: Mark “${label(item)}” open`
      : `Eddie Doc: Mark “${label(item)}” resolved`;
    const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    a.command = {
      command: "eddieDoc.toggleResolved",
      title,
      arguments: [item.id],
    };
    return a;
  }

  private preciseDeleteAction(
    document: vscode.TextDocument,
    item: ReviewItem,
    range: vscode.Range
  ): vscode.CodeAction {
    const a = new vscode.CodeAction(
      "Eddie Doc: Delete struck text",
      vscode.CodeActionKind.QuickFix
    );
    a.edit = new vscode.WorkspaceEdit();
    a.edit.delete(document.uri, withSpaceCleanup(document, range));
    a.command = {
      command: "eddieDoc.toggleResolved",
      title: "resolve",
      arguments: [item.id],
    };
    a.isPreferred = true;
    return a;
  }

  private replaceCmdAction(
    adocPath: string,
    item: ReviewItem,
    what: string
  ): vscode.CodeAction {
    const title = `Eddie Doc: Replace ${what} text…`;
    const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    a.command = {
      command: "eddieDoc.replaceMarked",
      title,
      arguments: [adocPath, item.id],
    };
    return a;
  }

  private insertCmdAction(
    adocPath: string,
    item: ReviewItem
  ): vscode.CodeAction {
    const title = "Eddie Doc: Insert text at mark…";
    const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    a.command = {
      command: "eddieDoc.insertAtMark",
      title,
      arguments: [adocPath, item.id],
    };
    return a;
  }

  private insertNoteAction(
    document: vscode.TextDocument,
    item: ReviewItem
  ): vscode.CodeAction {
    const line = effectiveLine(item);
    const a = new vscode.CodeAction(
      `Eddie Doc: Insert editor note as comment`,
      vscode.CodeActionKind.QuickFix
    );
    const indent = document.lineAt(line).text.match(/^\s*/)?.[0] ?? "";
    const who = item.author ? `${item.author}: ` : "";
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const text = `${indent}// ✎ ${KIND_LABEL[item.kind]} — ${who}${flatten(
      item.comment
    )}${eol}`;
    a.edit = new vscode.WorkspaceEdit();
    a.edit.insert(document.uri, new vscode.Position(line, 0), text);
    return a;
  }

  private deleteLinesAction(
    document: vscode.TextDocument,
    item: ReviewItem
  ): vscode.CodeAction {
    const start = effectiveLine(item);
    const end = Math.min(
      item.manualLine != null ? start : item.match?.endLine ?? start,
      document.lineCount - 1
    );
    const count = end - start + 1;
    const a = new vscode.CodeAction(
      `Eddie Doc: Delete whole struck line${count > 1 ? `s ${start + 1}–${end + 1}` : ""}`,
      vscode.CodeActionKind.RefactorRewrite
    );
    const endPos =
      end + 1 < document.lineCount
        ? new vscode.Position(end + 1, 0)
        : document.lineAt(end).range.end;
    a.edit = new vscode.WorkspaceEdit();
    a.edit.delete(
      document.uri,
      new vscode.Range(new vscode.Position(start, 0), endPos)
    );
    return a;
  }
}

/** Extend a deletion range to absorb one adjacent space, avoiding "a  b". */
function withSpaceCleanup(
  document: vscode.TextDocument,
  range: vscode.Range
): vscode.Range {
  const afterRange = new vscode.Range(range.end, range.end.translate(0, 1));
  if (document.getText(afterRange) === " ")
    return new vscode.Range(range.start, range.end.translate(0, 1));
  if (range.start.character > 0) {
    const beforeRange = new vscode.Range(
      range.start.translate(0, -1),
      range.start
    );
    if (document.getText(beforeRange) === " ")
      return new vscode.Range(range.start.translate(0, -1), range.end);
  }
  return range;
}

function label(item: ReviewItem): string {
  const t = (item.comment || item.anchoredText || KIND_LABEL[item.kind])
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

function flatten(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}
