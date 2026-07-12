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
  /** Tree contextValue, so group-specific inline actions can be targeted. */
  context?: string;
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

    if (!node) {
      const cfg = vscode.workspace.getConfiguration("eddieDoc");
      const showResolved = cfg.get<boolean>("showResolved", true);
      const highConf = cfg.get<number>("highConfidence", 0.75);

      const items = session.items.filter((i) => showResolved || !i.resolved);
      const matched = items.filter(
        (i) => !i.resolved && effectiveLine(i) !== UNMATCHED
      );
      const open = matched.filter((i) => isConfident(i, highConf));
      const review = matched.filter((i) => !isConfident(i, highConf));
      const unmatched = items.filter(
        (i) => !i.resolved && effectiveLine(i) === UNMATCHED
      );
      const done = items.filter((i) => i.resolved);

      const groups: GroupNode[] = [];
      const add = (label: string, arr: ItemNode[], context?: string) => {
        if (arr.length)
          groups.push({ type: "group", label, children: arr, context });
      };
      add(`Open (${open.length})`, toItems(open, session.adocPath));
      add(
        `Needs review (${review.length})`,
        toItems(review, session.adocPath)
      );
      add(
        `Unmatched (${unmatched.length})`,
        toItems(unmatched, session.adocPath),
        "group.unmatched"
      );
      add(`Resolved (${done.length})`, toItems(done, session.adocPath));
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
      ti.contextValue = node.context ?? "group";
      return ti;
    }

    const { item } = node;
    const line = effectiveLine(item);
    const highConf = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<number>("highConfidence", 0.75);
    const label = `${KIND_LABEL[item.kind]}: ${snippet(item)}`;
    const ti = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    ti.id = item.id;
    // Needs-review items get a distinct contextValue so the "confirm" action
    // only appears where it makes sense.
    const needsReview =
      !item.resolved &&
      line !== UNMATCHED &&
      !isConfident(item, highConf);
    ti.contextValue = needsReview ? "annotation.review" : "annotation";
    ti.iconPath = new vscode.ThemeIcon(
      item.resolved ? "check" : KIND_ICON[item.kind]
    );
    ti.description = `${locationLabel(item, line)}${
      item.author ? ` · ${item.author}` : ""
    }`;
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

/** A link we trust: hand-picked, confirmed, or a high-confidence auto-match. */
function isConfident(item: ReviewItem, highConf: number): boolean {
  if (item.manualLine != null || item.confirmed) return true;
  return (item.match?.score ?? 0) >= highConf;
}

/** "line 12 · 0.83" / "line 12 · manual" / "line 12 · semantic 0.71". */
function locationLabel(item: ReviewItem, line: number): string {
  if (line === UNMATCHED) return "no source match";
  const parts = [`line ${line + 1}`];
  if (item.manualLine != null) parts.push("manual");
  else if (item.match) {
    const m = item.match;
    parts.push(
      `${m.method === "semantic" ? "semantic " : ""}${m.score.toFixed(2)}`
    );
  }
  return parts.join(" · ");
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
