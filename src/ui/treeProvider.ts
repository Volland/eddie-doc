import * as vscode from "vscode";
import type { ReviewItem, ReviewSession } from "../model/types.js";
import { KIND_ICON, KIND_LABEL } from "../model/types.js";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";

type Node = GroupNode | ItemNode;

interface GroupNode {
  type: "group";
  label: string;
  children: ItemNode[];
}

interface ItemNode {
  type: "item";
  item: ReviewItem;
  adocPath: string;
}

const UNMATCHED = Number.MAX_SAFE_INTEGER;

export class AnnotationTreeProvider
  implements vscode.TreeDataProvider<Node>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    Node | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ReviewStore,
    private readonly getActiveAdoc: () => string | undefined
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  private activeSession(): ReviewSession | undefined {
    const active = this.getActiveAdoc();
    if (active) {
      const s = this.store.get(active);
      if (s) return s;
    }
    // Fall back to the most recently updated session.
    return this.store
      .all()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  getChildren(node?: Node): Node[] {
    const session = this.activeSession();
    if (!session) return [];
    const showResolved = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<boolean>("showResolved", true);

    if (!node) {
      const items = session.items.filter(
        (i) => showResolved || !i.resolved
      );
      const open = items.filter(
        (i) => !i.resolved && effectiveLine(i) !== UNMATCHED
      );
      const unmatched = items.filter(
        (i) => !i.resolved && effectiveLine(i) === UNMATCHED
      );
      const done = items.filter((i) => i.resolved);

      const groups: GroupNode[] = [];
      if (open.length)
        groups.push({ type: "group", label: `Open (${open.length})`, children: toItems(open, session.adocPath) });
      if (unmatched.length)
        groups.push({ type: "group", label: `Unmatched (${unmatched.length})`, children: toItems(unmatched, session.adocPath) });
      if (done.length)
        groups.push({ type: "group", label: `Resolved (${done.length})`, children: toItems(done, session.adocPath) });
      return groups;
    }

    if (node.type === "group") return node.children;
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "group") {
      const ti = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      ti.contextValue = "group";
      return ti;
    }

    const { item } = node;
    const line = effectiveLine(item);
    const label = `${KIND_LABEL[item.kind]}: ${snippet(item)}`;
    const ti = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    ti.id = item.id;
    ti.contextValue = "annotation";
    ti.iconPath = new vscode.ThemeIcon(
      item.resolved ? "check" : KIND_ICON[item.kind]
    );
    const where =
      line === UNMATCHED ? "no source match" : `line ${line + 1}`;
    ti.description = `${where}${item.author ? ` · ${item.author}` : ""}`;
    ti.tooltip = tooltip(item);
    if (line !== UNMATCHED) {
      ti.command = {
        command: "eddieDoc.revealAnnotation",
        title: "Reveal",
        arguments: [node.adocPath, item.id],
      };
    }
    return ti;
  }
}

function toItems(items: ReviewItem[], adocPath: string): ItemNode[] {
  return items.map((item) => ({ type: "item", item, adocPath }));
}

function snippet(item: ReviewItem): string {
  const text = item.comment || item.anchoredText || "(no text)";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 60) + "…" : clean;
}

function tooltip(item: ReviewItem): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${KIND_LABEL[item.kind]}** · page ${item.page}`);
  if (item.author) md.appendMarkdown(` · _${item.author}_`);
  md.appendMarkdown("\n\n");
  if (item.anchoredText)
    md.appendMarkdown(`> ${item.anchoredText.replace(/\n/g, " ")}\n\n`);
  if (item.comment) md.appendMarkdown(`💬 ${item.comment}\n\n`);
  if (item.match)
    md.appendMarkdown(
      `_match score ${item.match.score.toFixed(2)}_`
    );
  return md;
}
