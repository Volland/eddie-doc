/**
 * Threaded reply UI, built on VS Code's native Comments API.
 *
 * Each annotation becomes a comment thread anchored to the source line it maps
 * to: the editor's mark is the root post, and the author's replies hang beneath
 * it. That gives a reply box, an author, timestamps and a resolve toggle for
 * free, in the gutter next to the prose being discussed — the same interaction
 * as a pull-request review, which is what this workflow actually is.
 *
 * The editor's own mark is rendered read-only. It came from the PDF and is
 * immutable under the format's layering rule (`docs/FORMAT.md`): the annotation
 * block is what the editor said, and nothing in the editor should let the
 * author quietly rewrite it. Only replies are editable, and only by their author.
 */
import * as vscode from "vscode";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";
import { KIND_LABEL, type Reply, type ReviewItem } from "../model/types.js";
import { isAdocPath } from "../util.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** A comment in one of our threads, carrying the ids needed to mutate it. */
export interface ReviewComment extends vscode.Comment {
  /** Sidecar item this thread belongs to. */
  itemId: string;
  /** Reply id, or undefined for the editor's root mark. */
  replyId?: string;
  /** The source document the item lives in. */
  adocPath: string;
}

/** Threads for one document, so a re-render can dispose exactly what it owns. */
interface DocThreads {
  threads: vscode.CommentThread[];
}

/**
 * Mirrors the review store into a comment controller, rebuilding a document's
 * threads whenever its session changes.
 */
export class ReviewCommentController {
  private readonly controller: vscode.CommentController;
  private readonly byDoc = new Map<string, DocThreads>();

  constructor(private readonly store: ReviewStore) {
    this.controller = vscode.comments.createCommentController(
      "eddieDoc.review",
      "Eddie Doc Review"
    );
    // Threads are created from sidecar items, never by the user clicking in the
    // gutter — an annotation without an editor's mark behind it would have
    // nothing to write back into the PDF. Offering no commenting range keeps
    // the "+" affordance out of the gutter entirely.
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  }

  /** Rebuild threads for `adocPath` (or every open session when omitted). */
  refresh(adocPath?: string): void {
    if (adocPath) {
      this.rebuild(adocPath);
      return;
    }
    for (const session of this.store.all()) this.rebuild(session.adocPath);
  }

  private rebuild(adocPath: string): void {
    if (!isAdocPath(adocPath)) return;
    this.disposeDoc(adocPath);

    const session = this.store.get(adocPath);
    if (!session) return;
    const uri = vscode.Uri.file(adocPath);
    const showResolved = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<boolean>("showResolved", true);

    const threads: vscode.CommentThread[] = [];
    for (const item of session.items) {
      const line = effectiveLine(item);
      if (line === UNMATCHED) continue; // nowhere to put it; the tree handles these
      if (item.resolved && !showResolved) continue;

      const range = new vscode.Range(line, 0, line, 0);
      const thread = this.controller.createCommentThread(uri, range, []);
      thread.comments = [
        rootComment(item, adocPath),
        ...(item.replies ?? []).map((r) => replyComment(item, r, adocPath)),
      ];
      thread.label = threadLabel(item);
      thread.contextValue = "eddieDoc.thread";
      thread.state = item.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      // Collapse resolved threads and anything already answered; leave open,
      // unanswered marks expanded so the work still to do is what you see.
      thread.collapsibleState =
        item.resolved || (item.replies?.length ?? 0) > 0
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      threads.push(thread);
    }
    this.byDoc.set(adocPath, { threads });
  }

  private disposeDoc(adocPath: string): void {
    const existing = this.byDoc.get(adocPath);
    if (!existing) return;
    for (const t of existing.threads) t.dispose();
    this.byDoc.delete(adocPath);
  }

  dispose(): void {
    for (const path of [...this.byDoc.keys()]) this.disposeDoc(path);
    this.controller.dispose();
  }
}

/** The editor's mark, rendered as the immutable head of the thread. */
function rootComment(item: ReviewItem, adocPath: string): ReviewComment {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  const marked = (item.markedText || item.anchoredText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (marked) md.appendMarkdown(`> ${marked.slice(0, 400)}\n\n`);
  md.appendMarkdown(item.comment || `_${KIND_LABEL[item.kind]} with no note._`);

  return {
    itemId: item.id,
    adocPath,
    body: md,
    // Preview mode with no edit action — the PDF is the source of truth here.
    mode: vscode.CommentMode.Preview,
    author: { name: item.author || "Editor" },
    label: `${KIND_LABEL[item.kind]} · p${item.page}`,
    contextValue: "eddieDoc.mark",
  };
}

/** One of the author's replies — editable and deletable by them. */
function replyComment(
  item: ReviewItem,
  reply: Reply,
  adocPath: string
): ReviewComment {
  return {
    itemId: item.id,
    replyId: reply.id,
    adocPath,
    body: new vscode.MarkdownString(reply.body),
    mode: vscode.CommentMode.Preview,
    author: { name: reply.author },
    label: formatWhen(reply.createdAt),
    contextValue: "eddieDoc.reply",
  };
}

/** Header line for the thread: kind, page, and how the link was established. */
function threadLabel(item: ReviewItem): string {
  const bits = [KIND_LABEL[item.kind], `p${item.page}`];
  const m = item.match?.method;
  if (item.manualLine != null) bits.push("manual");
  else if (m === "marker" || m === "blockId" || m === "fingerprint")
    bits.push(`anchored · ${m}`);
  else if (item.match) bits.push(item.match.score.toFixed(2));
  const n = item.replies?.length ?? 0;
  if (n) bits.push(`${n} ${n === 1 ? "reply" : "replies"}`);
  return bits.join(" · ");
}

/** Short, locale-independent day stamp; the full time lives in the sidecar. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
