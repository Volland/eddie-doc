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
 *
 * Threads are *reconciled*, never rebuilt. A comment thread owns the popup and
 * the reply box inside it, so disposing one mid-conversation throws away the
 * half-typed reply, the focus and the expanded state — which made replying in
 * place impossible, since a store change (or merely clicking into the box) tore
 * the widget down under the cursor. So a refresh walks the live threads and
 * writes only the fields that actually differ, and `collapsibleState` — the
 * user's own hand on the disclosure triangle — is set once, at creation.
 */
import * as vscode from "vscode";
import { effectiveLine } from "../matching/mapper.js";
import type { ReviewStore } from "../model/store.js";
import type { Reply, ReviewItem } from "../model/types.js";
import { isAdocPath } from "../util.js";
import {
  markAuthor,
  rootMarkdown,
  threadLabel,
  threadSignature,
} from "./threadModel.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;
/** Key for the head post in a thread's comment cache; no reply owns "". */
const ROOT = "";

/** A comment in one of our threads, carrying the ids needed to mutate it. */
export interface ReviewComment extends vscode.Comment {
  /** Sidecar item this thread belongs to. */
  itemId: string;
  /** Reply id, or undefined for the editor's root mark. */
  replyId?: string;
  /** The source document the item lives in. */
  adocPath: string;
  /** Body as last persisted, so cancelling an in-place edit can put it back. */
  savedBody?: string | vscode.MarkdownString;
}

/** A live thread plus what it was rendered from, so a refresh can diff it. */
interface ThreadEntry {
  thread: vscode.CommentThread;
  /** `threadSignature` of the item as last rendered. */
  sig: string;
  /** Posts by reply id (`ROOT` for the mark), reused so edits-in-flight survive. */
  posts: Map<string, ReviewComment>;
}

/**
 * Mirrors the review store into a comment controller, reconciling a document's
 * threads whenever its session changes.
 */
export class ReviewCommentController {
  private readonly controller: vscode.CommentController;
  private readonly byDoc = new Map<string, Map<string, ThreadEntry>>();

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

  /** Reconcile threads for `adocPath` (or every open session when omitted). */
  refresh(adocPath?: string): void {
    if (adocPath) {
      this.sync(adocPath);
      return;
    }
    // Once per document, not once per mapping: a document with three rounds
    // still shows one thread per annotation, from the round on screen.
    for (const doc of this.store.documents()) this.sync(doc);
  }

  /** Swap a reply into its in-place editor, in the popup where it already is. */
  beginEdit(comment: ReviewComment): void {
    if (!comment?.replyId) return;
    comment.savedBody = snapshot(comment.body);
    comment.mode = vscode.CommentMode.Editing;
    this.rerender(comment);
  }

  /** Persist what the author typed in place, then fall back to preview. */
  finishEdit(comment: ReviewComment): void {
    if (!comment?.replyId) return;
    const body = bodyText(comment.body).trim();
    comment.mode = vscode.CommentMode.Preview;
    // An emptied box means "leave it as it was", not "store an empty reply";
    // deleting is its own explicit action.
    if (!body) {
      comment.body = comment.savedBody ?? comment.body;
      this.rerender(comment);
      return;
    }
    comment.savedBody = new vscode.MarkdownString(body);
    this.rerender(comment);
    this.store.editReply(comment.adocPath, comment.itemId, comment.replyId, body);
  }

  /** Abandon an in-place edit, restoring the reply as it was persisted. */
  cancelEdit(comment: ReviewComment): void {
    if (!comment?.replyId) return;
    comment.body = comment.savedBody ?? comment.body;
    comment.mode = vscode.CommentMode.Preview;
    this.rerender(comment);
  }

  /** Nudge the widget to redraw a thread we mutated behind VS Code's back. */
  private rerender(comment: ReviewComment): void {
    const entry = this.byDoc.get(comment.adocPath)?.get(comment.itemId);
    if (!entry) return;
    entry.thread.comments = [...entry.thread.comments];
  }

  private sync(adocPath: string): void {
    if (!isAdocPath(adocPath)) return;
    const session = this.store.get(adocPath);
    if (!session) {
      this.disposeDoc(adocPath);
      return;
    }
    const uri = vscode.Uri.file(adocPath);
    const showResolved = vscode.workspace
      .getConfiguration("eddieDoc")
      .get<boolean>("showResolved", true);

    const entries = this.byDoc.get(adocPath) ?? new Map<string, ThreadEntry>();
    const live = new Set<string>();
    for (const item of session.items) {
      const line = effectiveLine(item);
      if (line === UNMATCHED) continue; // nowhere to put it; the tree handles these
      if (item.resolved && !showResolved) continue;
      live.add(item.id);

      const existing = entries.get(item.id);
      if (existing) reconcile(existing, item, adocPath, line);
      else entries.set(item.id, this.create(uri, item, adocPath, line));
    }
    // Only threads whose annotation is gone (or now filtered out) go away.
    for (const [id, entry] of [...entries]) {
      if (live.has(id)) continue;
      entry.thread.dispose();
      entries.delete(id);
    }
    this.byDoc.set(adocPath, entries);
  }

  private create(
    uri: vscode.Uri,
    item: ReviewItem,
    adocPath: string,
    line: number
  ): ThreadEntry {
    const thread = this.controller.createCommentThread(
      uri,
      new vscode.Range(line, 0, line, 0),
      []
    );
    const entry: ThreadEntry = { thread, sig: threadSignature(item), posts: new Map() };
    thread.comments = buildPosts(entry, item, adocPath);
    thread.label = threadLabel(item);
    thread.contextValue = "eddieDoc.thread";
    thread.canReply = true;
    thread.state = threadState(item);
    // Collapse resolved threads and anything already answered; leave open,
    // unanswered marks expanded so the work still to do is what you see. This
    // is a first impression only — from here the disclosure state is the user's.
    thread.collapsibleState =
      item.resolved || (item.replies?.length ?? 0) > 0
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    return entry;
  }

  private disposeDoc(adocPath: string): void {
    const existing = this.byDoc.get(adocPath);
    if (!existing) return;
    for (const entry of existing.values()) entry.thread.dispose();
    this.byDoc.delete(adocPath);
  }

  dispose(): void {
    for (const path of [...this.byDoc.keys()]) this.disposeDoc(path);
    this.controller.dispose();
  }
}

/** Bring a live thread up to date with its item, touching as little as possible. */
function reconcile(
  entry: ThreadEntry,
  item: ReviewItem,
  adocPath: string,
  line: number
): void {
  const { thread } = entry;
  if (thread.range?.start.line !== line) {
    thread.range = new vscode.Range(line, 0, line, 0);
  }
  const label = threadLabel(item);
  if (thread.label !== label) thread.label = label;
  const state = threadState(item);
  if (thread.state !== state) thread.state = state;

  const sig = threadSignature(item);
  if (sig === entry.sig) return; // identical content: leave the widget alone
  entry.sig = sig;
  thread.comments = buildPosts(entry, item, adocPath);
}

/** The thread's posts, reusing the objects VS Code already holds where it can. */
function buildPosts(
  entry: ThreadEntry,
  item: ReviewItem,
  adocPath: string
): ReviewComment[] {
  const posts = [upsertRoot(entry, item, adocPath)];
  for (const reply of item.replies ?? []) {
    posts.push(upsertReply(entry, item, reply, adocPath));
  }
  const keep = new Set([ROOT, ...(item.replies ?? []).map((r) => r.id)]);
  for (const id of [...entry.posts.keys()]) {
    if (!keep.has(id)) entry.posts.delete(id);
  }
  return posts;
}

/** The editor's mark, rendered as the immutable head of the thread. */
function upsertRoot(
  entry: ThreadEntry,
  item: ReviewItem,
  adocPath: string
): ReviewComment {
  const md = new vscode.MarkdownString(rootMarkdown(item));
  md.supportThemeIcons = true;
  const label = threadLabel(item);
  const existing = entry.posts.get(ROOT);
  if (existing) {
    existing.body = md;
    existing.author = { name: markAuthor(item) };
    existing.label = label;
    return existing;
  }
  const post: ReviewComment = {
    itemId: item.id,
    adocPath,
    body: md,
    // Preview mode with no edit action — the PDF is the source of truth here.
    mode: vscode.CommentMode.Preview,
    author: { name: markAuthor(item) },
    label,
    contextValue: "eddieDoc.mark",
  };
  entry.posts.set(ROOT, post);
  return post;
}

/** One of the author's replies — editable and deletable by them, in place. */
function upsertReply(
  entry: ThreadEntry,
  item: ReviewItem,
  reply: Reply,
  adocPath: string
): ReviewComment {
  const existing = entry.posts.get(reply.id);
  if (existing) {
    existing.author = { name: reply.author };
    existing.label = formatWhen(reply.createdAt);
    // Mid-edit, the box holds unsaved text: overwriting the body here would
    // wipe out what the author is typing.
    if (existing.mode !== vscode.CommentMode.Editing) {
      existing.body = new vscode.MarkdownString(reply.body);
      existing.savedBody = new vscode.MarkdownString(reply.body);
    }
    return existing;
  }
  const post: ReviewComment = {
    itemId: item.id,
    replyId: reply.id,
    adocPath,
    body: new vscode.MarkdownString(reply.body),
    savedBody: new vscode.MarkdownString(reply.body),
    mode: vscode.CommentMode.Preview,
    author: { name: reply.author },
    label: formatWhen(reply.createdAt),
    contextValue: "eddieDoc.reply",
  };
  entry.posts.set(reply.id, post);
  return post;
}

function threadState(item: ReviewItem): vscode.CommentThreadState {
  return item.resolved
    ? vscode.CommentThreadState.Resolved
    : vscode.CommentThreadState.Unresolved;
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

/** A detached copy, so restoring a cancelled edit cannot read the edited text. */
function snapshot(body: string | vscode.MarkdownString): vscode.MarkdownString {
  return new vscode.MarkdownString(bodyText(body));
}

/** Short, locale-independent day stamp; the full time lives in the sidecar. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
