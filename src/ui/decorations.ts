import * as vscode from "vscode";
import type { ReviewItem } from "../model/types.js";
import { KIND_LABEL } from "../model/types.js";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";
import { isAdocDoc } from "../util.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** Paints gutter + inline markers on source lines that carry annotations. */
export class DecorationManager {
  private readonly open: vscode.TextEditorDecorationType;
  private readonly resolved: vscode.TextEditorDecorationType;

  constructor(private readonly store: ReviewStore) {
    this.open = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      backgroundColor: new vscode.ThemeColor(
        "editor.wordHighlightBackground"
      ),
      after: {
        margin: "0 0 0 1rem",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
    });
    this.resolved = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        margin: "0 0 0 1rem",
        color: new vscode.ThemeColor("disabledForeground"),
      },
    });
  }

  update(editor: vscode.TextEditor | undefined): void {
    if (!editor || !isAdocDoc(editor.document)) return;
    const adocPath = editor.document.uri.fsPath;
    const session = this.store.get(adocPath);
    if (!session) {
      editor.setDecorations(this.open, []);
      editor.setDecorations(this.resolved, []);
      return;
    }
    const showResolved = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<boolean>("showResolved", true);

    // Group items by line so a line with several notes gets one combined marker.
    const byLine = new Map<number, ReviewItem[]>();
    for (const it of session.items) {
      const line = effectiveLine(it);
      if (line === UNMATCHED) continue;
      if (it.resolved && !showResolved) continue;
      const arr = byLine.get(line) ?? [];
      arr.push(it);
      byLine.set(line, arr);
    }

    const openDecos: vscode.DecorationOptions[] = [];
    const resolvedDecos: vscode.DecorationOptions[] = [];
    for (const [line, items] of byLine) {
      if (line >= editor.document.lineCount) continue;
      const range = editor.document.lineAt(line).range;
      const allResolved = items.every((i) => i.resolved);
      const label = summarize(items);
      const deco: vscode.DecorationOptions = {
        range,
        renderOptions: { after: { contentText: `  ✎ ${label}` } },
        hoverMessage: buildHover(items),
      };
      (allResolved ? resolvedDecos : openDecos).push(deco);
    }
    editor.setDecorations(this.open, openDecos);
    editor.setDecorations(this.resolved, resolvedDecos);
  }

  dispose(): void {
    this.open.dispose();
    this.resolved.dispose();
  }
}

function summarize(items: ReviewItem[]): string {
  if (items.length === 1) {
    const it = items[0];
    const c = (it.comment || it.anchoredText || "").replace(/\s+/g, " ").trim();
    return `${KIND_LABEL[it.kind]}${c ? `: ${c.slice(0, 50)}` : ""}${
      c.length > 50 ? "…" : ""
    }`;
  }
  return `${items.length} annotations`;
}

function buildHover(items: ReviewItem[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  for (const it of items) {
    md.appendMarkdown(
      `**${KIND_LABEL[it.kind]}**${it.author ? ` · _${it.author}_` : ""}${
        it.resolved ? " · ✅ resolved" : ""
      } · p${it.page}\n\n`
    );
    if (it.anchoredText)
      md.appendMarkdown(`> ${it.anchoredText.replace(/\n/g, " ")}\n\n`);
    if (it.comment) md.appendMarkdown(`💬 ${it.comment}\n\n`);
    const toggle = vscode.Uri.parse(
      `command:eddieDoc.toggleResolved?${encodeURIComponent(
        JSON.stringify([it.id])
      )}`
    );
    md.appendMarkdown(
      `[${it.resolved ? "Mark open" : "Mark resolved"}](${toggle})\n\n---\n\n`
    );
  }
  return md;
}
