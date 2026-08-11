import * as vscode from "vscode";
import type { ReviewItem, ReviewSession } from "../model/types.js";
import {
  KIND_ICON,
  KIND_LABEL,
  PDF_ROLE_LABEL,
  REVIEW_TYPE_LABEL,
  mappingLabel,
  revisionLabel,
} from "../model/types.js";
import { effectiveLine, isConfident } from "../matching/mapper.js";
import { commentRef, refPrefix, withoutRef } from "../model/refs.js";
import type { ReviewStore } from "../model/store.js";

type Node = GroupNode | ItemNode | MappingNode;

interface GroupNode {
  type: "group";
  label: string;
  children: Node[];
  /** Tree contextValue, so group-specific inline actions can be targeted. */
  context?: string;
  /** Groups of rounds start collapsed; the working groups stay open. */
  collapsed?: boolean;
}

interface ItemNode {
  type: "item";
  item: ReviewItem;
  adocPath: string;
}

/** One of the document's other mappings — a click switches the view to it. */
interface MappingNode {
  type: "mapping";
  session: ReviewSession;
  active: boolean;
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
    // A focused .adoc strictly governs which pair the tree shows: its own
    // session, or nothing (so navigating to an unreviewed .adoc doesn't leak a
    // different pair's annotations). Only with no .adoc in focus at all — e.g. a
    // freshly opened window — do we fall back to the most recent review.
    const active = this.getActiveAdoc();
    if (active) return this.store.get(active);
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

      // A document reviewed over several rounds gets its other mappings listed
      // at the bottom, so switching between them never needs the command
      // palette. One mapping means there is nothing to switch to — no group.
      const siblings = this.store.sessionsFor(session.adocPath);
      if (siblings.length > 1) {
        groups.push({
          type: "group",
          label: `Rounds (${this.store.revisionsFor(session.adocPath).length})`,
          context: "group.revisions",
          collapsed: true,
          children: siblings.map((s) => ({
            type: "mapping" as const,
            session: s,
            active: s.sidecarPath === session.sidecarPath,
          })),
        });
      }
      return groups;
    }

    if (node.type === "group") return node.children;
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "group") {
      const ti = new vscode.TreeItem(
        node.label,
        node.collapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
      );
      ti.contextValue = node.context ?? "group";
      return ti;
    }

    if (node.type === "mapping") return mappingTreeItem(node);

    const { item } = node;
    const line = effectiveLine(item);
    const highConf = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<number>("highConfidence", 0.75);
    // The editor's query number leads: it is how the remark is addressed.
    const label = `${refPrefix(item)}${KIND_LABEL[item.kind]}: ${snippet(item)}`;
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

/** A row for one of the document's mappings: which round, whose marks, progress. */
function mappingTreeItem(node: MappingNode): vscode.TreeItem {
  const { session, active } = node;
  const ti = new vscode.TreeItem(
    `${revisionLabel(session.revision)} · ${mappingLabel(session)}`,
    vscode.TreeItemCollapsibleState.None
  );
  ti.id = `mapping:${session.sidecarPath}`;
  ti.contextValue = active ? "mapping.active" : "mapping";
  ti.iconPath = new vscode.ThemeIcon(active ? "circle-filled" : "circle-outline");
  const open = session.items.filter((i) => !i.resolved).length;
  ti.description = `${open} open / ${session.items.length}${
    active ? " · showing" : ""
  }`;
  ti.tooltip = mappingTooltip(session);
  if (!active) {
    ti.command = {
      command: "eddieDoc.activateMapping",
      title: "Show this round",
      arguments: [session.sidecarPath],
    };
  }
  return ti;
}

function mappingTooltip(session: ReviewSession): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${revisionLabel(session.revision)}**\n\n`);
  const rows: string[] = [`- Mapping: \`${session.mapping.id}\``];
  if (session.mapping.origin) rows.push(`- From: ${session.mapping.origin}`);
  if (session.mapping.reviewer) rows.push(`- Reviewer: ${session.mapping.reviewer}`);
  if (session.mapping.reviewType)
    rows.push(`- Pass: ${REVIEW_TYPE_LABEL[session.mapping.reviewType]}`);
  rows.push(
    `- PDF: ${PDF_ROLE_LABEL[session.pdf?.role ?? "annotated"]}` +
      (session.pdf?.imported ? " (imported)" : "")
  );
  if (session.revision.receivedAt)
    rows.push(`- Received: ${session.revision.receivedAt.slice(0, 10)}`);
  if (session.revision.note) rows.push(`- Note: ${session.revision.note}`);
  md.appendMarkdown(rows.join("\n"));
  return md;
}


/** "line 12 · 0.83" / "line 12 · manual" / "line 12 · semantic 0.71". */
function locationLabel(item: ReviewItem, line: number): string {
  if (line === UNMATCHED) return "no source match";
  const parts = [`line ${line + 1}`];
  if (item.manualLine != null) parts.push("manual");
  else if (item.match) {
    const m = item.match;
    parts.push(
      `${m.method && m.method !== "fuzzy" ? `${m.method} ` : ""}${m.score.toFixed(2)}`
    );
  }
  // Where it last sat, not where it belongs — say so on the row rather than
  // letting a number imply a confidence the link no longer has.
  if (item.stale) parts.push("stale");
  return parts.join(" · ");
}

function snippet(item: ReviewItem): string {
  // Hoisted into the label already, so it does not spend the 60 characters here.
  const text = withoutRef(item.comment) || item.anchoredText || "(no text)";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 60) + "…" : clean;
}

function tooltip(item: ReviewItem): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const ref = commentRef(item.comment);
  md.appendMarkdown(
    `${ref ? `**${ref}** · ` : ""}**${KIND_LABEL[item.kind]}** · page ${item.page}`
  );
  if (item.author) md.appendMarkdown(` · _${item.author}_`);
  md.appendMarkdown("\n\n");
  if (item.anchoredText)
    md.appendMarkdown(`> ${item.anchoredText.replace(/\n/g, " ")}\n\n`);
  if (item.comment) md.appendMarkdown(`💬 ${item.comment}\n\n`);
  if (item.stale)
    md.appendMarkdown(
      `⚠️ **Stale** — the text this was linked to has changed, so this is ` +
        `where the mark last sat, not where it belongs. Confirm it or re-link ` +
        `it once you have decided whether the remark still applies.\n\n`
    );
  if (item.match)
    md.appendMarkdown(
      `_match score ${item.match.score.toFixed(2)}_`
    );
  return md;
}
