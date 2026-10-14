/**
 * Every Eddie Doc capability as a CLI verb.
 *
 * Each command mirrors one VS Code command and runs the same core code through
 * the same {@link ReviewStore}, so a review moved between the editor and a
 * terminal is the same review. Where the editor asks a question in a dialog,
 * the CLI takes a flag, and where it confirms a change to the manuscript, the
 * CLI asks on a terminal and requires `--yes` when there is no one to ask.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { all, has, list, num, str, UsageError, type ArgSpec, type ParsedArgs } from "./args.js";
import { CliError, Workspace, type Io } from "./workspace.js";
import { openFile, outputPath, renderSessionReport, writeReport } from "./actions.js";
import { TuiApp } from "./tui/app.js";
import { runTerminal } from "./tui/term.js";
import { skillsCommand } from "./skills.js";
import { clip, countsText, itemJson, itemLabel, itemRow, line1, mappingJson } from "./present.js";
import type { LoadedSettings } from "./config.js";
import { extractAnnotations, readPages } from "../../core/pdf/extract.js";
import { mapAnnotations, effectiveLine, isConfident } from "../../core/matching/mapper.js";
import { lexicalFallback } from "../../core/matching/lexical.js";
import { buildSourceIndex, topMatches } from "../../core/matching/fuzzyMatch.js";
import { renderReport } from "../../core/model/report.js";
import {
  defaultRevision,
  parse as parseSidecar,
  resolveSourcePath,
  serialize,
  PRODUCER,
} from "../../core/model/format.js";
import {
  documentFolder,
  reviewRoot,
  revisionId,
} from "../../core/model/layout.js";
import {
  itemPdfPath,
  KIND_LABEL,
  mappingLabel,
  revisionLabel,
  type AnnotationKind,
  type PdfRole,
  type ReviewItem,
  type ReviewSession,
  type ReviewType,
  type RevisionInfo,
} from "../../core/model/types.js";
import { anchorItems, type AnchorResult } from "../../core/pdf/anchor.js";
import { stampPdf } from "../../core/pdf/stamp.js";
import { annotationsToAdoc, extractedAdocPath } from "../../core/pdf/toAdoc.js";
import {
  describeAnchor,
  findMarkers,
  injectMarkers,
  stripMarkers,
  type MarkerTarget,
} from "../../core/source/markers.js";
import {
  applyEdits,
  availableActions,
  overlaps,
  parseSuggestion,
  planAllConfident,
  planDeleteLines,
  planDeleteStruck,
  planInsertAtMark,
  planInsertNote,
  planReplaceMarked,
  type EditAction,
  type TextEdit,
} from "../../core/edits/plan.js";
import {
  applyFilter,
  BUCKET_LABEL,
  BUCKET_ORDER,
  countBuckets,
  groupItems,
  isLocated,
  type Bucket,
} from "../../core/view/annotationView.js";

const UNMATCHED = Number.MAX_SAFE_INTEGER;

/** What a command gets: its arguments, the terminal, and a lazily-built workspace. */
export interface Ctx {
  args: ParsedArgs;
  io: Io;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  /** The workspace, built on first use so `help` and `extract` need none. */
  ws(): Workspace;
  loaded(): LoadedSettings;
  root(): string;
}

export interface Command {
  name: string;
  aliases?: string[];
  group: Group;
  summary: string;
  usage: string;
  /** Longer help, shown by `eddie help <command>`. */
  details?: string;
  /** The VS Code command this one mirrors, for the docs. */
  vscode?: string;
  spec?: Partial<ArgSpec>;
  run(ctx: Ctx): Promise<number>;
}

export type Group = "Reviews and rounds" | "Annotations" | "Editing the source" | "Outputs" | "Workspace";

export const GROUPS: Group[] = [
  "Reviews and rounds",
  "Annotations",
  "Editing the source",
  "Outputs",
  "Workspace",
];

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function threshold(ws: Workspace): number {
  return ws.settings.matchThreshold;
}

function emit(ctx: Ctx, value: unknown): void {
  ctx.io.out(JSON.stringify(value, null, 2));
}

/** Ask before changing the manuscript; `--yes` answers for a script. */
async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  if (ctx.yes) return true;
  if (!ctx.io.interactive) {
    throw new CliError(`${question} — refusing without a terminal to ask on; pass --yes`);
  }
  const a = await ctx.io.ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(a);
}

/** The document and its selected mapping, from `<source.adoc>` + `--mapping`/`--round`. */
async function docAndMapping(ctx: Ctx, adocArg: string | undefined) {
  const ws = ctx.ws();
  const adoc = await ws.requireDoc(adocArg);
  const session = ws.pickMapping(adoc, str(ctx.args, "mapping"), num(ctx.args, "round"));
  return { ws, adoc, session };
}

/** Text from positionals, or stdin when the only one is `-`. */
async function textArg(ctx: Ctx, parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") return ctx.io.readStdin();
  return parts.join(" ");
}

/**
 * Pin each mark to its paragraph with `// eddie:` markers, then re-map through
 * them. The editor does this right after mapping, while the text still matches
 * what the reviewer read — the one moment matching is trustworthy.
 */
async function writeAnchors(
  ws: Workspace,
  adoc: string
): Promise<{ inserted: number; anchored: number } | undefined> {
  const before = readFileSync(adoc, "utf8");
  const res = ws.store.buildAnchors(adoc, before);
  if (!res || res.inserted === 0) return res;
  writeFileSync(adoc, res.source, "utf8");
  await ws.store.remapAll(adoc, threshold(ws));
  return res;
}

const REVIEW_TYPES: ReviewType[] = ["copyedit", "proofread", "developmental", "technical", "legal", "other"];
const PDF_ROLES: PdfRole[] = ["annotated", "proof", "clean", "stamped", "other"];

function reviewType(v: string | undefined): ReviewType | undefined {
  if (v === undefined || v === "") return undefined;
  if (!REVIEW_TYPES.includes(v as ReviewType)) {
    throw new UsageError(`--type must be one of ${REVIEW_TYPES.join(", ")}`);
  }
  return v as ReviewType;
}

function pdfRole(v: string | undefined): PdfRole | undefined {
  if (v === undefined) return undefined;
  if (!PDF_ROLES.includes(v as PdfRole)) {
    throw new UsageError(`--role must be one of ${PDF_ROLES.join(", ")}`);
  }
  return v as PdfRole;
}

// ---------------------------------------------------------------------------
// Reviews and rounds
// ---------------------------------------------------------------------------

const open: Command = {
  name: "open",
  aliases: ["review"],
  group: "Reviews and rounds",
  vscode: "Open PDF Review / Start New Review Round / Add Annotated PDF to Current Round",
  summary: "Map an annotated PDF onto its AsciiDoc source",
  usage:
    "open <source.adoc> <annotated.pdf> [--new-round | --round N] [--label L] [--origin O]\n" +
    "     [--reviewer R] [--type copyedit|proofread|…] [--import] [--no-anchor]",
  details:
    "Extracts every highlight, strikeout, comment and insert from the PDF and links each\n" +
    "to the source line it marks. By default the PDF joins the document's current round\n" +
    "(a second editor's copy of the same pass); --new-round starts the next one, carrying\n" +
    "resolved state and replies forward. Re-opening the same PDF in the same round\n" +
    "refreshes that mapping in place. Unless --no-anchor (or autoAnchor=false), `// eddie:`\n" +
    "marker comments are written into the source so the marks survive later rewrites.",
  spec: { values: ["label", "origin", "reviewer", "type", "role"] },
  async run(ctx) {
    const [adocArg, pdfArg] = ctx.args.positional;
    if (!adocArg || !pdfArg) throw new UsageError("open needs <source.adoc> <annotated.pdf>");
    const ws = ctx.ws();
    const adoc = ws.abs(adocArg);
    const pdf = ws.abs(pdfArg);
    for (const [f, a] of [[adoc, adocArg], [pdf, pdfArg]]) {
      if (!existsSync(f)) throw new CliError(`no such file: ${a}`);
    }
    if (/\.pdf$/i.test(adoc) && /\.(adoc|asciidoc)$/i.test(pdf)) {
      throw new UsageError("arguments are <source.adoc> <annotated.pdf> — in that order");
    }
    await ws.store.tryLoadSidecar(adoc);
    const existing = ws.store.sessionsFor(adoc);

    let revision: RevisionInfo;
    const round = num(ctx.args, "round");
    if (has(ctx.args, "new-round")) revision = ws.store.nextRevision(adoc);
    else if (round != null) {
      revision =
        ws.store.revisionsFor(adoc).find((r) => r.ordinal === round) ??
        { id: revisionId(round), ordinal: round };
    } else revision = ws.store.latestRevision(adoc) ?? ws.store.nextRevision(adoc);

    const rebind = existing.find(
      (s) =>
        s.revision.id === revision.id &&
        s.pdfPath &&
        (path.resolve(s.pdfPath) === pdf ||
          (s.pdf?.importedFrom && path.resolve(s.pdf.importedFrom) === pdf))
    );
    const mapping = {
      label: str(ctx.args, "label"),
      origin: str(ctx.args, "origin"),
      reviewer: str(ctx.args, "reviewer"),
      reviewType: reviewType(str(ctx.args, "type")),
    };
    ctx.io.note(`${rebind ? "re-mapping" : "mapping"} ${path.basename(pdf)} → ${path.basename(adoc)}…`);
    const session = await ws.store.loadReview(adoc, pdf, {
      threshold: threshold(ws),
      revision,
      sidecarPath: rebind?.sidecarPath,
      mapping,
      pdfRole: pdfRole(str(ctx.args, "role")) ?? rebind?.pdf?.role ?? "annotated",
      importPdf: has(ctx.args, "import") || (ws.settings.importPdfs && !has(ctx.args, "no-import")),
    });
    const matched = session.items.filter((i) => effectiveLine(i) !== UNMATCHED).length;
    if (session.items.length >= 5 && matched / session.items.length < 0.4) {
      ctx.io.note(
        `warning: only ${matched} of ${session.items.length} annotations mapped — check that ` +
          `${path.basename(pdf)} is really the annotated PDF for ${path.basename(adoc)}, then run: eddie triage`
      );
    }
    let anchors: { inserted: number; anchored: number } | undefined;
    if (ws.settings.autoAnchor && !has(ctx.args, "no-anchor")) {
      anchors = await writeAnchors(ws, adoc);
    }
    await ws.store.flush();
    const s = ws.store.getBySidecar(session.sidecarPath) ?? session;
    const counts = countBuckets(s.items, ws.settings.highConfidence);
    if (ctx.json) {
      emit(ctx, { ...mappingJson(s, counts, true), anchored: anchors?.anchored ?? 0, markers: anchors?.inserted ?? 0 });
      return 0;
    }
    ctx.io.out(ws.show(s.sidecarPath));
    ctx.io.note(
      `${revisionLabel(s.revision)} · ${mappingLabel(s)} — ${s.items.length} annotation(s), ${matched} mapped to source`
    );
    ctx.io.note(countsText(counts));
    if (anchors?.inserted) {
      ctx.io.note(
        `anchored ${anchors.anchored} annotation(s) with ${anchors.inserted} marker comment(s) in ${path.basename(adoc)} ` +
          `(eddie strip removes them)`
      );
    }
    return 0;
  },
};

const append: Command = {
  name: "append",
  group: "Reviews and rounds",
  vscode: "Add PDFs to This Mapping…",
  summary: "Add more PDFs' marks to an existing mapping",
  usage: "append <source.adoc> <file.pdf>... [--mapping M] [--origin O] [--reviewer R] [--role R] [--import]",
  details:
    "The editor sent the chapter again with more marks, or a second copy of the same pass\n" +
    "arrived. New marks join the mapping and continue its numbering; marks it already has\n" +
    "are skipped; numbers, resolutions and replies stay as they were.",
  spec: { values: ["origin", "reviewer", "role"] },
  async run(ctx) {
    const [adocArg, ...pdfs] = ctx.args.positional;
    if (!pdfs.length) throw new UsageError("append needs <source.adoc> and at least one PDF");
    const { ws, session } = await docAndMapping(ctx, adocArg);
    const results = [];
    for (const p of pdfs) {
      const pdf = ws.abs(p);
      if (!existsSync(pdf)) throw new CliError(`no such file: ${p}`);
      const r = await ws.store.appendPdf(session.sidecarPath, pdf, {
        threshold: threshold(ws),
        origin: str(ctx.args, "origin"),
        reviewer: str(ctx.args, "reviewer"),
        pdfRole: pdfRole(str(ctx.args, "role")),
        importPdf: has(ctx.args, "import") || ws.settings.importPdfs,
      });
      results.push({ pdf, added: r.added.length, duplicates: r.duplicates, alreadyPresent: !!r.alreadyPresent });
      ctx.io.note(
        r.alreadyPresent
          ? `${path.basename(pdf)}: already part of ${mappingLabel(session)}, skipped`
          : `${path.basename(pdf)}: ${r.added.length} new mark(s), ${r.duplicates} already present`
      );
    }
    await ws.store.flush();
    if (ctx.json) emit(ctx, { mapping: session.sidecarPath, results });
    else ctx.io.out(ws.show(session.sidecarPath));
    return 0;
  },
};

const merge: Command = {
  name: "merge",
  group: "Reviews and rounds",
  vscode: "Merge Mappings into This One…",
  summary: "Fold other mappings of a document into one",
  usage: "merge <source.adoc> <mapping>... --into <mapping>",
  details:
    "Moves the PDFs, marks and review state of each named mapping into the --into mapping\n" +
    "(default: the newest), then deletes their sidecars. The target is written first.",
  spec: { values: ["into"] },
  async run(ctx) {
    const [adocArg, ...others] = ctx.args.positional;
    if (!others.length) throw new UsageError("merge needs <source.adoc> and the mappings to fold in");
    const ws = ctx.ws();
    const adoc = await ws.requireDoc(adocArg);
    const target = ws.pickMapping(adoc, str(ctx.args, "into") ?? str(ctx.args, "mapping"));
    const sources = others.map((o) => ws.pickMapping(adoc, o).sidecarPath);
    ws.store.setActive(target.sidecarPath);
    if (!(await confirm(ctx, `Merge ${sources.length} mapping(s) into ${mappingLabel(target)} and delete their sidecars?`))) {
      return 1;
    }
    const r = await ws.store.mergeMappings(target.sidecarPath, sources);
    if (ctx.json) emit(ctx, { into: target.sidecarPath, ...r });
    else {
      ctx.io.out(ws.show(target.sidecarPath));
      ctx.io.note(`removed ${r.removed.length} mapping(s)` + (r.failed.length ? `; failed: ${r.failed.join("; ")}` : ""));
    }
    return r.failed.length ? 1 : 0;
  },
};

const rounds: Command = {
  name: "rounds",
  aliases: ["mappings"],
  group: "Reviews and rounds",
  vscode: "Switch Round / Mapping",
  summary: "List the rounds and mappings of a document, or of every reviewed document",
  usage: "rounds [source.adoc] [--json]",
  details:
    "Without a source, lists every mapping in the workspace, grouped by document.\n" +
    "The CLI has no 'active' mapping between runs: every per-document command acts on the\n" +
    "newest mapping (marked *) unless given --mapping <id> or --round N.\n" +
    "To browse and act on them interactively, run: eddie tui",
  async run(ctx) {
    const ws = ctx.ws();
    const hc = ws.settings.highConfidence;
    let docs: string[];
    if (ctx.args.positional[0]) docs = [await ws.requireDoc(ctx.args.positional[0])];
    else {
      await ws.loadAll();
      docs = ws.store.documents().sort();
      if (!docs.length && !ctx.json) {
        ctx.io.out("no reviews in this workspace — start one with: eddie open <source.adoc> <annotated.pdf>");
        return 0;
      }
    }
    if (ctx.json) {
      emit(
        ctx,
        docs.flatMap((adoc) => {
          const sessions = ws.store.sessionsFor(adoc);
          const newest = sessions[sessions.length - 1];
          return sessions.map((s) => mappingJson(s, countBuckets(s.items, hc), s === newest));
        })
      );
      return 0;
    }
    for (const adoc of docs) {
      if (docs.length > 1 || !ctx.args.positional[0]) ctx.io.out(`${ws.show(adoc)}`);
      const indent = docs.length > 1 || !ctx.args.positional[0] ? "  " : "";
      printRounds(ctx, ws, adoc, indent);
    }
    return 0;
  },
};

function printRounds(ctx: Ctx, ws: Workspace, adoc: string, indent: string): void {
  const hc = ws.settings.highConfidence;
  const sessions = ws.store.sessionsFor(adoc);
  const newest = sessions[sessions.length - 1];
  for (const rev of ws.store.revisionsFor(adoc)) {
    ctx.io.out(`${indent}${revisionLabel(rev)}${rev.receivedAt ? `  (received ${rev.receivedAt})` : ""}`);
    for (const s of sessions.filter((x) => x.revision.id === rev.id)) {
      const c = countBuckets(s.items, hc);
      const who = [s.mapping.origin, s.mapping.reviewer].filter(Boolean).join(" / ");
      ctx.io.out(
        `${indent}  ${s === newest ? "*" : " "} ${`${rev.id}/${s.mapping.id}`.padEnd(32)} ${mappingLabel(s)}` +
          `${who && who !== mappingLabel(s) ? ` — ${who}` : ""}`
      );
      ctx.io.out(`${indent}      ${countsText(c)}`);
      ctx.io.out(`${indent}      ${ws.show(s.sidecarPath)}`);
    }
  }
}

const describe: Command = {
  name: "describe",
  aliases: ["edit-round"],
  group: "Reviews and rounds",
  vscode: "Edit Round Details…",
  summary: "Set a mapping's label, origin, reviewer, type, and its round's details",
  usage:
    "describe <source.adoc> [--mapping M] [--label L] [--origin O] [--reviewer R] [--type T]\n" +
    "         [--role R] [--round-label L] [--received YYYY-MM-DD] [--round-note N]",
  details: "An empty value clears a field: --label ''. Round details are shared by every mapping in the round.",
  spec: { values: ["label", "origin", "reviewer", "type", "role", "round-label", "received", "round-note"] },
  async run(ctx) {
    const { ws, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    const patch: Record<string, unknown> = {};
    const set = (flag: string, key: string, map: (v: string) => unknown = (v) => v) => {
      const v = str(ctx.args, flag);
      if (v !== undefined) patch[key] = v === "" ? undefined : map(v);
    };
    set("label", "label");
    set("origin", "origin");
    set("reviewer", "reviewer");
    set("type", "reviewType", (v) => reviewType(v));
    const revision: Partial<RevisionInfo> = {};
    let touchedRound = false;
    for (const [flag, key] of [["round-label", "label"], ["received", "receivedAt"], ["round-note", "note"]] as const) {
      const v = str(ctx.args, flag);
      if (v !== undefined) {
        (revision as Record<string, unknown>)[key] = v === "" ? undefined : v;
        touchedRound = true;
      }
    }
    if (touchedRound) patch.revision = revision;
    const role = pdfRole(str(ctx.args, "role"));
    if (role) patch.pdfRole = role;
    if (!Object.keys(patch).length) {
      throw new UsageError("nothing to change — pass --label, --origin, --reviewer, --type, --role or a --round-* flag");
    }
    ws.store.describeMapping(session.sidecarPath, patch);
    await ws.store.flush();
    const s = ws.store.getBySidecar(session.sidecarPath)!;
    if (ctx.json) emit(ctx, mappingJson(s, countBuckets(s.items, ws.settings.highConfidence), true));
    else ctx.io.out(`${revisionLabel(s.revision)} · ${mappingLabel(s)}`);
    return 0;
  },
};

const remove: Command = {
  name: "delete",
  aliases: ["delete-mapping", "rm"],
  group: "Reviews and rounds",
  vscode: "Remove This Mapping…",
  summary: "Delete a mapping's sidecar (the source and PDFs are untouched)",
  usage: "delete <source.adoc> --mapping M [--yes]",
  async run(ctx) {
    if (!str(ctx.args, "mapping") && num(ctx.args, "round") == null) {
      throw new UsageError("delete needs --mapping (or --round) so nothing is removed by default");
    }
    const { ws, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    if (!(await confirm(ctx, `Delete mapping ${mappingLabel(session)} (${session.items.length} annotations, their replies and resolutions)?`))) {
      return 1;
    }
    const ok = await ws.store.deleteMapping(session.sidecarPath);
    if (ok) ctx.io.out(ws.show(session.sidecarPath));
    return ok ? 0 : 1;
  },
};

const remap: Command = {
  name: "remap",
  aliases: ["refresh"],
  group: "Reviews and rounds",
  vscode: "Re-map Annotations",
  summary: "Re-run matching for every round against the current source",
  usage: "remap <source.adoc> [--only-changed]",
  details:
    "Re-uses the annotations already extracted — the PDF is not re-read. Run it after\n" +
    "editing the source outside the editor. --only-changed skips mappings whose source\n" +
    "hash has not changed since they were last matched.",
  async run(ctx) {
    const ws = ctx.ws();
    const adoc = await ws.requireDoc(ctx.args.positional[0]);
    const n = await ws.store.remapAll(adoc, threshold(ws), { onlyIfSourceChanged: has(ctx.args, "only-changed") });
    await ws.store.flush();
    const sessions = ws.store.sessionsFor(adoc);
    if (ctx.json) {
      emit(ctx, {
        remapped: n,
        mappings: sessions.map((s) => mappingJson(s, countBuckets(s.items, ws.settings.highConfidence), false)),
      });
      return 0;
    }
    ctx.io.out(`re-mapped ${n} mapping(s) across ${ws.store.revisionsFor(adoc).length} round(s)`);
    const newest = sessions[sessions.length - 1];
    if (newest) ctx.io.note(`newest: ${countsText(countBuckets(newest.items, ws.settings.highConfidence))}`);
    return 0;
  },
};

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

const BUCKETS = BUCKET_ORDER;
const KINDS: AnnotationKind[] = ["highlight", "strikeout", "underline", "comment", "insert", "replace", "other"];

const listCmd: Command = {
  name: "list",
  aliases: ["ls"],
  group: "Annotations",
  vscode: "the PDF Annotations tree",
  summary: "List annotations grouped as Open / Needs review / Unmatched / Resolved",
  usage:
    "list <source.adoc> [--mapping M] [--bucket open,review,unmatched,resolved] [--kind K]\n" +
    "     [--page N] [--text T] [--hide-resolved] [--json]",
  spec: { values: ["bucket", "kind", "page", "text"] },
  async run(ctx) {
    const { ws, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    const hc = ws.settings.highConfidence;
    const buckets = list(ctx.args, "bucket") as Bucket[];
    for (const b of buckets) if (!BUCKETS.includes(b)) throw new UsageError(`--bucket must be one of ${BUCKETS.join(", ")}`);
    const kinds = list(ctx.args, "kind").map((k) => (k === "delete" ? "strikeout" : k)) as AnnotationKind[];
    for (const k of kinds) if (!KINDS.includes(k)) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
    const items = applyFilter(
      session.items,
      {
        hideResolved: has(ctx.args, "hide-resolved") || !ws.settings.showResolved,
        buckets,
        kinds,
        page: num(ctx.args, "page"),
        text: str(ctx.args, "text"),
      },
      hc
    );
    if (ctx.json) {
      emit(ctx, {
        mapping: mappingJson(session, countBuckets(session.items, hc), true),
        items: items.map((i) => itemJson(i, hc)),
      });
      return 0;
    }
    ctx.io.note(`${revisionLabel(session.revision)} · ${mappingLabel(session)} — ${countsText(countBuckets(session.items, hc))}`);
    for (const g of groupItems(items, hc)) {
      ctx.io.out(g.label);
      for (const it of g.items) ctx.io.out(`  ${itemRow(it)}`);
    }
    return 0;
  },
};

const show: Command = {
  name: "show",
  group: "Annotations",
  vscode: "Reveal in Source / the comment thread",
  summary: "Show one annotation: marks, source lines, match and reply thread",
  usage: "show <source.adoc> <item> [--mapping M] [--context N] [--json]",
  details: "<item> is a remark number (3 or #3), an annotation id, or a unique id prefix.",
  spec: { values: ["context"] },
  async run(ctx) {
    const [adocArg, ref] = ctx.args.positional;
    const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    const hc = ws.settings.highConfidence;
    if (ctx.json) {
      emit(ctx, { ...itemJson(it, hc), pdf: itemPdfPath(session, it), mapping: session.sidecarPath });
      return 0;
    }
    const lines = readFileSync(adoc, "utf8").split(/\r?\n/);
    const l = line1(it);
    ctx.io.out(`${itemLabel(it)}  [${KIND_LABEL[it.kind]}]  page ${it.page}  ${BUCKET_LABEL[itemJson(it, hc).bucket]}`);
    ctx.io.out(`id:       ${it.id}`);
    if (it.author) ctx.io.out(`author:   ${it.author}`);
    if (it.comment) ctx.io.out(`comment:  ${it.comment.replace(/\s+/g, " ").trim()}`);
    if (it.markedText) ctx.io.out(`marked:   "${clip(it.markedText, 200)}"`);
    if (it.anchoredText) ctx.io.out(`context:  "${clip(it.anchoredText, 200)}"`);
    if (l == null) ctx.io.out("source:   unmatched — eddie triage, or eddie relink <adoc> <item> <line>");
    else {
      const how = it.manualLine != null ? "linked by hand" : `${it.match?.method ?? "fuzzy"} ${it.match?.score.toFixed(2)}`;
      ctx.io.out(`source:   line ${l} (${how}${it.confirmed ? ", confirmed" : ""}${it.stale ? ", STALE" : ""})`);
      const span = num(ctx.args, "context") ?? 1;
      const end = it.manualLine != null ? l : (it.match?.endLine ?? l - 1) + 1;
      for (let n = Math.max(1, l - span); n <= Math.min(lines.length, end + span); n++) {
        const mark = n >= l && n <= end ? ">" : " ";
        ctx.io.out(`  ${mark}${String(n).padStart(5)} │ ${lines[n - 1]}`);
      }
    }
    if (it.anchor) ctx.io.out(`anchor:   ${it.anchor.marker ? `marker ${it.anchor.marker}` : it.anchor.blockId ? `block ${it.anchor.blockId}` : "fingerprint"}`);
    if (it.note) ctx.io.out(`note:     ${it.note}`);
    for (const r of it.replies ?? []) {
      ctx.io.out(`  ↳ ${r.author} · ${r.createdAt.slice(0, 16).replace("T", " ")} · ${r.id}`);
      for (const line of r.body.split(/\r?\n/)) ctx.io.out(`    ${line}`);
    }
    return 0;
  },
};

/** Resolve, reopen and confirm share their shape: a document and some items. */
function itemsCommand(
  name: string,
  opts: Omit<Command, "run" | "name" | "usage"> & {
    apply(ws: Workspace, adoc: string, it: ReviewItem): string | undefined;
  }
): Command {
  return {
    ...opts,
    name,
    usage: `${name} <source.adoc> <item>... [--mapping M] [--all-located]`,
    async run(ctx) {
      const [adocArg, ...refs] = ctx.args.positional;
      const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
      const targets = has(ctx.args, "all-located")
        ? session.items.filter(isLocated)
        : refs.map((r) => ws.findItem(session, r));
      if (!targets.length) throw new UsageError(`${name} needs at least one <item>`);
      const changed: string[] = [];
      for (const it of targets) {
        const msg = opts.apply(ws, adoc, it);
        if (msg) {
          changed.push(it.id);
          ctx.io.note(`${itemLabel(it)}: ${msg}`);
        }
      }
      await ws.store.flush();
      if (ctx.json) emit(ctx, { changed });
      else ctx.io.out(`${changed.length} annotation(s) updated`);
      return 0;
    },
  };
}

const resolve = itemsCommand("resolve", {
  group: "Annotations",
  vscode: "Toggle Resolved",
  summary: "Mark annotations resolved",
  apply(ws, adoc, it) {
    if (it.resolved) return undefined;
    ws.store.toggleResolved(adoc, it.id);
    return "resolved";
  },
});

const reopen = itemsCommand("reopen", {
  aliases: ["unresolve"],
  group: "Annotations",
  vscode: "Toggle Resolved",
  summary: "Mark annotations open again",
  apply(ws, adoc, it) {
    if (!it.resolved) return undefined;
    ws.store.toggleResolved(adoc, it.id);
    return "reopened";
  },
});

const confirmCmd = itemsCommand("confirm", {
  group: "Annotations",
  vscode: "Confirm Match",
  summary: "Vouch for low-confidence or stale matches (moves them out of Needs review)",
  apply(ws, adoc, it) {
    if (it.confirmed && !it.stale) return undefined;
    ws.store.confirmMatch(adoc, it.id);
    return "confirmed";
  },
});

const relink: Command = {
  name: "relink",
  group: "Annotations",
  vscode: "Re-link to Current Cursor Line / Reselect Source Line",
  summary: "Link an annotation to a source line by hand",
  usage: "relink <source.adoc> <item> <line> [--mapping M]",
  details: "<line> is 1-based, as an editor shows it. A hand-picked link counts as confirmed.",
  async run(ctx) {
    const [adocArg, ref, lineArg] = ctx.args.positional;
    const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    const n = Number(lineArg);
    const count = readFileSync(adoc, "utf8").split(/\r?\n/).length;
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new UsageError(`<line> must be between 1 and ${count}`);
    }
    ws.store.relink(adoc, it.id, n - 1);
    await ws.store.flush();
    if (ctx.json) emit(ctx, itemJson(ws.store.findItem(adoc, it.id)!, ws.settings.highConfidence));
    else ctx.io.out(`${itemLabel(it)} → line ${n}`);
    return 0;
  },
};

const remapItem: Command = {
  name: "remap-item",
  group: "Annotations",
  vscode: "Re-map This Annotation",
  summary: "Re-run automatic matching for one annotation, dropping a manual link",
  usage: "remap-item <source.adoc> <item> [--mapping M]",
  async run(ctx) {
    const [adocArg, ref] = ctx.args.positional;
    const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    await ws.store.remapItem(adoc, it.id, threshold(ws));
    await ws.store.flush();
    const after = ws.store.findItem(adoc, it.id)!;
    const placed = line1(after) != null && !after.stale;
    if (ctx.json) emit(ctx, itemJson(after, ws.settings.highConfidence));
    else if (!placed) ctx.io.out(`${itemLabel(after)}: no confident source match — link it by hand with: eddie relink`);
    else ctx.io.out(`${itemLabel(after)} → line ${line1(after)}`);
    return placed ? 0 : 1;
  },
};

const triage: Command = {
  name: "triage",
  group: "Annotations",
  vscode: "Triage Unmatched Annotations",
  summary: "Suggest source lines for unmatched annotations; -i to link them one by one",
  usage: "triage <source.adoc> [--mapping M] [--candidates N] [-i | --interactive] [--json]",
  details:
    "Without -i, prints each unmatched annotation with a ranked shortlist of candidate\n" +
    "lines (link one with `eddie relink`). With -i, asks for each: a candidate number,\n" +
    "L<line> for any line, s to skip, q to stop.",
  spec: { values: ["candidates"], aliases: { i: "interactive" } },
  async run(ctx) {
    const { ws, adoc, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    const source = readFileSync(adoc, "utf8");
    const lines = source.split(/\r?\n/);
    const idx = buildSourceIndex(source);
    const k = num(ctx.args, "candidates") ?? 5;
    const queue = session.items.filter((i) => !i.resolved && effectiveLine(i) === UNMATCHED);
    const plan = queue.map((it) => ({
      item: it,
      candidates: topMatches(it.anchoredText || it.comment || "", idx, k),
    }));
    if (ctx.json) {
      emit(
        ctx,
        plan.map((p) => ({
          ...itemJson(p.item, ws.settings.highConfidence),
          candidates: p.candidates.map((c) => ({
            line: c.startLine + 1,
            endLine: c.endLine + 1,
            score: c.score,
            text: lines[c.startLine],
          })),
        }))
      );
      return 0;
    }
    if (!queue.length) {
      ctx.io.out("no unmatched annotations to triage");
      return 0;
    }
    const interactive = has(ctx.args, "interactive");
    if (interactive && !ctx.io.interactive) throw new CliError("triage -i needs a terminal");
    let linked = 0;
    let skipped = 0;
    for (let qi = 0; qi < plan.length; qi++) {
      const { item, candidates } = plan[qi];
      ctx.io.out(`\n[${qi + 1}/${plan.length}] ${itemLabel(item)} [${KIND_LABEL[item.kind]}] p${item.page}`);
      if (item.comment) ctx.io.out(`  comment: ${clip(item.comment, 120)}`);
      if (item.anchoredText) ctx.io.out(`  marked:  "${clip(item.anchoredText, 120)}"`);
      candidates.forEach((c, i) =>
        ctx.io.out(`  ${i + 1}) L${String(c.startLine + 1).padEnd(5)} ${c.score.toFixed(2)}  ${clip(lines[c.startLine], 90)}`)
      );
      if (!candidates.length) ctx.io.out("  (no candidates — give a line with L<n>)");
      if (!interactive) continue;
      for (;;) {
        const a = (await ctx.io.ask("  link [1-9 | L<line> | s skip | q quit] > ")).toLowerCase();
        if (a === "q") {
          ctx.io.out(`\ntriage — ${linked} linked, ${skipped} skipped, ${plan.length - qi} not reached`);
          await ws.store.flush();
          return 0;
        }
        if (a === "s" || a === "") {
          skipped++;
          break;
        }
        let line: number | undefined;
        const lm = /^l(\d+)$/.exec(a);
        if (lm) line = Number(lm[1]) - 1;
        else if (/^\d+$/.test(a) && candidates[Number(a) - 1]) line = candidates[Number(a) - 1].startLine;
        if (line == null || line < 0 || line >= lines.length) {
          ctx.io.note("  ? answer with a candidate number, L<line>, s or q");
          continue;
        }
        ws.store.relink(adoc, item.id, line);
        linked++;
        ctx.io.out(`  → linked to line ${line + 1}`);
        break;
      }
    }
    await ws.store.flush();
    if (interactive) ctx.io.out(`\ntriage — ${linked} linked, ${skipped} skipped`);
    else ctx.io.note(`\nlink one with: eddie relink ${ws.show(adoc)} <item> <line>  (or run triage -i)`);
    return 0;
  },
};

const reply: Command = {
  name: "reply",
  group: "Annotations",
  vscode: "Reply / Edit Reply / Delete Reply",
  summary: "Add, edit or delete a reply in an annotation's thread",
  usage:
    "reply <source.adoc> <item> <text...>            add a reply (text '-' reads stdin)\n" +
    "reply <source.adoc> <item> --edit <reply-id> <text...>\n" +
    "reply <source.adoc> <item> --delete <reply-id>\n" +
    "      [--mapping M] [--author NAME]",
  details: "Replies are stored in the sidecar and are stamped into reviewed PDFs. The author\ndefaults to authorName, then git config user.name.",
  spec: { values: ["edit", "delete"] },
  async run(ctx) {
    const [adocArg, ref, ...words] = ctx.args.positional;
    const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    const del = str(ctx.args, "delete");
    const edit = str(ctx.args, "edit");
    if (del) {
      if (!it.replies?.some((r) => r.id === del)) throw new CliError(`no reply ${del} on ${itemLabel(it)}`);
      ws.store.deleteReply(adoc, it.id, del);
    } else {
      const body = (await textArg(ctx, words)).trim();
      if (!body) throw new UsageError("reply needs some text");
      if (edit) {
        if (!it.replies?.some((r) => r.id === edit)) throw new CliError(`no reply ${edit} on ${itemLabel(it)}`);
        ws.store.editReply(adoc, it.id, edit, body);
      } else ws.store.addReply(adoc, it.id, ws.authorName(), body);
    }
    await ws.store.flush();
    const after = ws.store.findItem(adoc, it.id)!;
    if (ctx.json) emit(ctx, after.replies ?? []);
    else if (del) ctx.io.out(`deleted ${del}`);
    else ctx.io.out(edit ?? after.replies![after.replies!.length - 1].id);
    return 0;
  },
};

const preview: Command = {
  name: "preview",
  group: "Annotations",
  vscode: "Preview in PDF",
  summary: "Print (or --open) the PDF and page an annotation came from",
  usage: "preview <source.adoc> <item> [--mapping M] [--open]",
  async run(ctx) {
    const [adocArg, ref] = ctx.args.positional;
    const { ws, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    const pdf = itemPdfPath(session, it);
    if (ctx.json) emit(ctx, { pdf, page: it.page, rect: it.rect });
    else ctx.io.out(`${pdf}#page=${it.page}`);
    if (has(ctx.args, "open")) openFile(pdf);
    return 0;
  },
};

// ---------------------------------------------------------------------------
// Editing the source
// ---------------------------------------------------------------------------

const applyCmd: Command = {
  name: "apply",
  group: "Editing the source",
  vscode: "Apply All Confident Edits",
  summary: "Apply every confident deletion, replacement and insertion to the source",
  usage: "apply <source.adoc> [--mapping M] [--dry-run] [--yes]",
  details:
    "Struck text is deleted; highlights and replacements whose note carries a suggestion\n" +
    "are replaced; insert marks get the suggested text. Only unresolved, precisely located\n" +
    "items at or above highConfidence are touched. Applied items are marked resolved.",
  async run(ctx) {
    const { ws, adoc, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    const source = readFileSync(adoc, "utf8");
    const hc = ws.settings.highConfidence;
    const planned = planAllConfident(source, session.items, (i) => isConfident(i, hc));
    if (ctx.json && (ctx.dryRun || !planned.length)) {
      emit(ctx, planned.map((p) => ({ id: p.id, label: p.label, ...p.edit })));
      return 0;
    }
    if (!planned.length) {
      ctx.io.out("no actionable, confident edits to apply");
      return 0;
    }
    if (overlaps(planned.map((p) => p.edit))) {
      throw new CliError("some edits overlap — apply them one at a time with: eddie fix");
    }
    planned.forEach((p, i) => ctx.io.note(`${String(i + 1).padStart(3)}. ${p.label}`));
    if (ctx.dryRun) {
      ctx.io.out(`would apply ${planned.length} edit(s) to ${path.basename(adoc)}`);
      return 0;
    }
    if (!(await confirm(ctx, `Apply ${planned.length} edit(s) to ${path.basename(adoc)}?`))) return 1;
    writeFileSync(adoc, applyEdits(source, planned.map((p) => p.edit)), "utf8");
    for (const p of planned) ws.store.toggleResolved(adoc, p.id);
    // What the editor's on-save re-map does: positions follow the new text.
    await ws.store.remapAll(adoc, threshold(ws), { onlyIfSourceChanged: true });
    await ws.store.flush();
    if (ctx.json) emit(ctx, planned.map((p) => ({ id: p.id, label: p.label, ...p.edit })));
    else ctx.io.out(`applied ${planned.length} edit(s) to ${ws.show(adoc)}`);
    return 0;
  },
};

const FIX_ACTIONS: EditAction[] = ["delete-struck", "delete-lines", "replace-marked", "insert-at-mark", "insert-note"];

const fix: Command = {
  name: "fix",
  group: "Editing the source",
  vscode: "the lightbulb Quick Fixes",
  summary: "Apply one annotation's suggested edit (delete, replace, insert, note)",
  usage:
    "fix <source.adoc> <item> [action] [--text T] [--mapping M] [--dry-run] [--keep-open]\n" +
    "    actions: delete-struck | delete-lines | replace-marked | insert-at-mark | insert-note",
  details:
    "Without an action, lists the actions available for the item. replace-marked and\n" +
    "insert-at-mark use --text, else the suggestion parsed from the editor's note. The\n" +
    "item is marked resolved afterwards unless --keep-open (insert-note never resolves).",
  spec: { values: ["text"] },
  async run(ctx) {
    const [adocArg, ref, action] = ctx.args.positional;
    const { ws, adoc, session } = await docAndMapping(ctx, adocArg);
    const it = ws.findItem(session, ref);
    const available = availableActions(it, isLocated(it));
    if (!action) {
      if (ctx.json) emit(ctx, available);
      else if (!available.length) ctx.io.out(`${itemLabel(it)} has no edit actions${isLocated(it) ? "" : " (it is unmatched)"}`);
      else for (const a of available) ctx.io.out(`${a.action.padEnd(16)} ${a.label}`);
      return 0;
    }
    if (!FIX_ACTIONS.includes(action as EditAction)) throw new UsageError(`unknown action "${action}"`);
    if (!available.some((a) => a.action === action)) {
      throw new CliError(`${action} does not apply to ${itemLabel(it)} — run: eddie fix ${adocArg} ${ref}`);
    }
    const source = readFileSync(adoc, "utf8");
    const text = str(ctx.args, "text") ?? parseSuggestion(it.comment || "");
    let edit: TextEdit | null = null;
    switch (action as EditAction) {
      case "delete-struck": edit = planDeleteStruck(source, it); break;
      case "delete-lines": edit = planDeleteLines(source, it); break;
      case "insert-note": edit = planInsertNote(source, it); break;
      case "replace-marked":
        if (!text) throw new UsageError("replace-marked needs --text (the note has no suggestion)");
        edit = planReplaceMarked(source, it, text);
        break;
      case "insert-at-mark":
        if (!text) throw new UsageError("insert-at-mark needs --text (the note has no suggestion)");
        edit = planInsertAtMark(source, it, text);
        break;
    }
    if (!edit) throw new CliError(`could not locate the marked text precisely — edit by hand at line ${line1(it)}`);
    const before = source.slice(edit.from, edit.to);
    ctx.io.note(`- ${JSON.stringify(before)}\n+ ${JSON.stringify(edit.insert)}`);
    if (ctx.dryRun) {
      if (ctx.json) emit(ctx, edit);
      return 0;
    }
    writeFileSync(adoc, applyEdits(source, [edit]), "utf8");
    if (action !== "insert-note" && !has(ctx.args, "keep-open") && !it.resolved) {
      ws.store.toggleResolved(adoc, it.id);
    }
    await ws.store.remapAll(adoc, threshold(ws), { onlyIfSourceChanged: true });
    await ws.store.flush();
    if (ctx.json) emit(ctx, edit);
    else ctx.io.out(`${itemLabel(it)}: ${action} applied to ${ws.show(adoc)}`);
    return 0;
  },
};

const anchor: Command = {
  name: "anchor",
  group: "Editing the source",
  vscode: "Anchor Annotations in Source",
  summary: "Write `// eddie:` marker comments so marks survive rewrites",
  usage: "anchor <source.adoc> [--mapping M] [--review sidecar.json] [--dry-run]",
  details:
    "Markers are AsciiDoc comments: they never render, and they keep annotations attached\n" +
    "to their paragraph when the text is rewritten. `eddie strip` removes them.\n" +
    "--review anchors from one sidecar file directly, without the review folder.",
  spec: { values: ["review"] },
  async run(ctx) {
    const adocArg = ctx.args.positional[0];
    const review = str(ctx.args, "review");
    if (review) return anchorFromSidecar(ctx, adocArg, review);
    const { ws, adoc } = await docAndMapping(ctx, adocArg);
    const before = readFileSync(adoc, "utf8");
    const res = ws.store.buildAnchors(adoc, before);
    if (!res) return 1;
    if (ctx.dryRun) {
      ctx.io.out(`would insert ${res.inserted} marker(s) and anchor ${res.anchored} annotation(s)`);
      return 0;
    }
    if (res.inserted === 0) {
      ctx.io.out(res.anchored ? `all ${res.anchored} located annotation(s) were already anchored` : "nothing to anchor — no annotation has a source location yet");
      return 0;
    }
    writeFileSync(adoc, res.source, "utf8");
    await ws.store.remapAll(adoc, threshold(ws));
    await ws.store.flush();
    ctx.io.out(ws.show(adoc));
    ctx.io.note(`inserted ${res.inserted} marker(s); anchored ${res.anchored} annotation(s)`);
    return 0;
  },
};

/** The original single-sidecar `anchor --review`, kept for build scripts. */
async function anchorFromSidecar(ctx: Ctx, adocPath: string | undefined, sidecarPath: string): Promise<number> {
  if (!adocPath) throw new UsageError("usage: anchor <source.adoc> --review <sidecar.json> [--dry-run]");
  const session = loadSession(sidecarPath, adocPath);
  if (!session) throw new CliError(`cannot read ${sidecarPath}`);
  const before = readFileSync(adocPath, "utf8");
  const targets: MarkerTarget[] = [];
  for (const it of session.items) {
    const line = effectiveLine(it);
    if (line !== UNMATCHED) targets.push({ itemId: it.id, line });
  }
  const res = injectMarkers(before, targets);
  const markers = findMarkers(res.source);
  let anchored = 0;
  for (const it of session.items) {
    const id = res.assigned.get(it.id);
    const hit = id ? markers.get(id) : undefined;
    if (!id || !hit) continue;
    it.anchor = describeAnchor(res.source, hit.targetLine, id);
    anchored++;
  }
  if (ctx.dryRun) {
    ctx.io.note(`would insert ${res.inserted} marker(s) and anchor ${anchored} annotation(s)`);
    return 0;
  }
  writeFileSync(adocPath, res.source);
  session.updatedAt = new Date().toISOString();
  writeFileSync(sidecarPath, serialize(session, sidecarPath), "utf8");
  ctx.io.out(`${adocPath}`);
  ctx.io.note(`inserted ${res.inserted} marker(s); anchored ${anchored} annotation(s)`);
  return 0;
}

const strip: Command = {
  name: "strip",
  group: "Editing the source",
  vscode: "Remove Source Anchors",
  summary: "Remove every `// eddie:` marker from a source file",
  usage: "strip <source.adoc> [--dry-run]",
  async run(ctx) {
    const adocPath = ctx.args.positional[0];
    if (!adocPath) throw new UsageError("usage: strip <source.adoc> [--dry-run]");
    const before = readFileSync(adocPath, "utf8");
    const after = stripMarkers(before);
    const removed = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
    if (ctx.dryRun) {
      ctx.io.note(`would remove ${removed} marker(s)`);
      return 0;
    }
    if (after !== before) writeFileSync(adocPath, after);
    ctx.io.out(`${adocPath}`);
    ctx.io.note(`removed ${removed} marker(s)`);
    return 0;
  },
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const report: Command = {
  name: "report",
  aliases: ["export"],
  group: "Outputs",
  vscode: "Export Review Report",
  summary: "Write a mapping's Markdown review report",
  usage: "report <source.adoc> [--mapping M] [-o out.md | --stdout] [--no-resolved]",
  details:
    "Groups annotations as Open / Needs review / Unmatched / Resolved with line numbers,\n" +
    "comments and replies. Goes to the round's folder unless reportOutput=besideSource or -o.",
  async run(ctx) {
    const { ws, session } = await docAndMapping(ctx, ctx.args.positional[0]);
    const includeResolved = !has(ctx.args, "no-resolved");
    if (has(ctx.args, "stdout")) {
      process.stdout.write(await renderSessionReport(ws, session, includeResolved));
      return 0;
    }
    const out = str(ctx.args, "out");
    const outPath = await writeReport(ws, session, { outPath: out ? ws.abs(out) : undefined, includeResolved });
    ctx.io.out(ws.show(outPath));
    return 0;
  },
};

const stamp: Command = {
  name: "stamp",
  group: "Outputs",
  vscode: "Stamp Reviewed PDF",
  summary: "Write the review's marks and replies into a freshly rendered PDF",
  usage:
    "stamp <fresh.pdf> <source.adoc> [--mapping M | --all-in-round] [-o out.pdf] [--no-resolved]\n" +
    "stamp <fresh.pdf> --review <sidecar.json>... [-o out.pdf] [--no-resolved] [--fail-on-unstamped]",
  details:
    "Positions are re-derived from the current source, never from stored geometry, so\n" +
    "repagination does not matter. The clean render is never modified. With a source,\n" +
    "the output goes where stampOutput says (the round's pdf/ folder by default);\n" +
    "--all-in-round stamps every mapping of the selected round onto one PDF.",
  spec: { values: ["review"] },
  async run(ctx) {
    const [pdfArg, adocArg] = ctx.args.positional;
    if (!pdfArg) throw new UsageError("stamp needs <fresh.pdf>");
    const reviews = all(ctx.args, "review");
    let sessions: ReviewSession[];
    let ws: Workspace | undefined;
    let primary: ReviewSession | undefined;
    if (reviews.length) {
      sessions = [];
      for (const s of reviews) {
        const session = loadSession(s);
        if (!session) ctx.io.note(`  ! ${path.basename(s)}: unreadable, skipped`);
        else sessions.push(session);
      }
    } else {
      if (!adocArg) throw new UsageError("stamp needs <source.adoc> or --review <sidecar.json>");
      const picked = await docAndMapping(ctx, adocArg);
      ws = picked.ws;
      primary = picked.session;
      sessions = has(ctx.args, "all-in-round")
        ? ws.store.sessionsFor(picked.adoc).filter((s) => s.revision.id === primary!.revision.id)
        : [primary];
    }
    const pdfPath = path.resolve(pdfArg);
    const fallback = pdfPath.replace(/\.pdf$/i, "") + ".reviewed.pdf";
    const outPath = str(ctx.args, "out")
      ? path.resolve(str(ctx.args, "out")!)
      : ws && primary
        ? outputPath(ws, primary, ws.settings.stampOutput, fallback, "pdf")
        : fallback;
    if (outPath === pdfPath) throw new UsageError("refusing to overwrite the clean render in place — pass -o");

    const bytes = new Uint8Array(readFileSync(pdfPath));
    const pages = await readPages(bytes);
    ctx.io.note(`${path.basename(pdfPath)}: ${pages.length} page(s)`);
    const res: AnchorResult = { anchored: [], unstamped: [] };
    for (const session of sessions) {
      const source = readFileSync(session.adocPath, "utf8");
      const r = anchorItems(session.items, source, pages);
      res.anchored.push(...r.anchored);
      res.unstamped.push(...r.unstamped);
      ctx.io.note(
        `  ${path.basename(session.sidecarPath)}: ${r.anchored.length} placed, ` +
          `${r.unstamped.length} un-stampable of ${session.items.length}`
      );
    }
    const result = await stampPdf(bytes, res.anchored, { includeResolved: !has(ctx.args, "no-resolved") });
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.bytes);
    if (ws) {
      for (const s of sessions) {
        ws.store.recordArtifact(s.sidecarPath, {
          kind: "stampedPdf",
          path: outPath,
          createdAt: new Date().toISOString(),
          note: `stamped from ${path.basename(pdfPath)}`,
        });
      }
      await ws.store.flush();
    }
    const byPrecision = tally(res.anchored.map((a) => a.precision));
    ctx.io.out(`${ws ? ws.show(outPath) : outPath}`);
    ctx.io.note(
      `wrote ${result.marks} mark(s) and ${result.replies} repl(ies) — ` +
        `${byPrecision.exact ?? 0} exact, ${byPrecision.line ?? 0} line-level, ${byPrecision.block ?? 0} block` +
        (result.skippedResolved ? `, ${result.skippedResolved} resolved skipped` : "")
    );
    if (res.unstamped.length) {
      ctx.io.note(`\n${res.unstamped.length} annotation(s) could not be placed:`);
      for (const u of res.unstamped) {
        ctx.io.note(`  · [${KIND_LABEL[u.item.kind]}] ${clip(u.item.comment || u.item.anchoredText, 60)}`);
        ctx.io.note(`      ${u.reason}`);
      }
    }
    return has(ctx.args, "fail-on-unstamped") && res.unstamped.length ? 1 : 0;
  },
};

const extract: Command = {
  name: "extract",
  group: "Outputs",
  vscode: "Extract Annotations as AsciiDoc",
  summary: "Dump a PDF's annotations as a standalone AsciiDoc file (or JSON)",
  usage: "extract <annotated.pdf> [-o out.adoc | --stdout] [--json]",
  async run(ctx) {
    const pdfArg = ctx.args.positional[0];
    if (!pdfArg) throw new UsageError("extract needs <annotated.pdf>");
    const pdf = path.resolve(pdfArg);
    const annots = await extractAnnotations(new Uint8Array(readFileSync(pdf)));
    if (ctx.json) {
      emit(ctx, annots);
      return 0;
    }
    const adoc = annotationsToAdoc(pdf, annots, new Date().toISOString());
    if (has(ctx.args, "stdout")) {
      process.stdout.write(adoc);
      return 0;
    }
    const outPath = path.resolve(str(ctx.args, "out") ?? extractedAdocPath(pdf));
    writeFileSync(outPath, adoc, "utf8");
    ctx.io.out(outPath);
    ctx.io.note(`extracted ${annots.length} annotation(s)`);
    return 0;
  },
};

const map: Command = {
  name: "map",
  group: "Outputs",
  summary: "Extract and match without saving anything (inspection harness)",
  usage: "map <annotated.pdf> <source.adoc> [--json] [--report] [--lexical]",
  details: "Nothing is written. Useful in CI to check a PDF still maps onto its source.",
  async run(ctx) {
    const [pdfPath, adocPath] = ctx.args.positional;
    if (!pdfPath || !adocPath) throw new UsageError("map needs <annotated.pdf> <source.adoc>");
    const data = new Uint8Array(readFileSync(pdfPath));
    const source = readFileSync(adocPath, "utf8");
    const annots = await extractAnnotations(data);
    const items = mapAnnotations(annots, source, { threshold: 0.5 });
    if (has(ctx.args, "lexical")) lexicalFallback(items, source, 0.6);
    if (ctx.json) {
      ctx.io.out(JSON.stringify(items, null, 2));
      return 0;
    }
    if (has(ctx.args, "report")) {
      const now = new Date().toISOString();
      ctx.io.out(
        renderReport({
          version: 3,
          // `map` never writes a sidecar; this session exists only to be rendered.
          sidecarPath: "",
          adocPath,
          pdfPath,
          revision: defaultRevision(),
          mapping: { id: "map", kind: "annotations" },
          pdf: { role: "annotated" },
          createdAt: now,
          updatedAt: now,
          items,
        })
      );
      return 0;
    }
    const rawLines = source.split(/\r?\n/);
    ctx.io.out(`Extracted ${annots.length} annotation(s):\n`);
    for (const it of items) {
      const line = effectiveLine(it);
      const loc = line === UNMATCHED ? "UNMATCHED" : `L${line + 1}  (score ${it.match?.score.toFixed(2) ?? "manual"})`;
      ctx.io.out(`● [${KIND_LABEL[it.kind]}] p${it.page}  → ${loc}`);
      if (it.anchoredText) ctx.io.out(`    anchored: "${clip(it.anchoredText, 90)}"`);
      if (it.comment) ctx.io.out(`    comment:  "${clip(it.comment, 90)}"`);
      if (line !== UNMATCHED) ctx.io.out(`    source:   ${clip(rawLines[line] || "", 90)}`);
      ctx.io.out();
    }
    return 0;
  },
};

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const status: Command = {
  name: "status",
  aliases: ["reviews"],
  group: "Workspace",
  vscode: "Switch Review",
  summary: "Every reviewed document in the workspace, with open counts",
  usage: "status [--json]",
  async run(ctx) {
    const ws = ctx.ws();
    await ws.loadAll();
    const hc = ws.settings.highConfidence;
    const docs = ws.store.documents().map((adoc) => {
      const sessions = ws.store.sessionsFor(adoc);
      const newest = sessions[sessions.length - 1];
      return {
        source: adoc,
        rounds: ws.store.revisionsFor(adoc).length,
        mappings: sessions.length,
        open: sessions.reduce((n, s) => n + s.items.filter((i) => !i.resolved).length, 0),
        total: sessions.reduce((n, s) => n + s.items.length, 0),
        newest: newest ? { ref: `${newest.revision.id}/${newest.mapping.id}`, counts: countBuckets(newest.items, hc) } : null,
        updatedAt: sessions.map((s) => s.updatedAt).sort().pop() ?? "",
      };
    });
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (ctx.json) {
      emit(ctx, { root: ws.opts.root, reviewFolder: reviewRoot(ws.store.layoutConfig) ?? null, documents: docs });
      return 0;
    }
    if (!docs.length) {
      ctx.io.out("no reviews in this workspace — start one with: eddie open <source.adoc> <annotated.pdf>");
      return 0;
    }
    for (const d of docs) {
      ctx.io.out(`${ws.show(d.source)}`);
      ctx.io.out(
        `    ${d.open} open of ${d.total} · ${d.rounds} round(s)` +
          (d.mappings > d.rounds ? ` · ${d.mappings} mappings` : "") +
          (d.newest ? ` · newest ${d.newest.ref}` : "")
      );
    }
    return 0;
  },
};

const folder: Command = {
  name: "folder",
  group: "Workspace",
  vscode: "Open Review Folder",
  summary: "Print the review folder (or one document's folder in it)",
  usage: "folder [source.adoc] [--open]",
  async run(ctx) {
    const ws = ctx.ws();
    const adoc = ctx.args.positional[0];
    const target = adoc
      ? documentFolder(ws.store.layoutConfig, ws.abs(adoc))
      : reviewRoot(ws.store.layoutConfig);
    if (!target) {
      ctx.io.out("(legacy layout: sidecars sit beside each .adoc — reviewFolder is empty)");
      return 0;
    }
    ctx.io.out(target);
    if (has(ctx.args, "open")) openFile(target);
    return 0;
  },
};

const migrate: Command = {
  name: "migrate",
  group: "Workspace",
  vscode: "Move Reviews into Review Folder…",
  summary: "Move sidecars that sit beside their .adoc into the review folder",
  usage: "migrate [--dry-run] [--yes]",
  async run(ctx) {
    const ws = ctx.ws();
    await ws.loadAll();
    const steps = ws.store.planMigration();
    if (!steps.length) {
      ctx.io.out("nothing to move — every review is already in the review folder");
      return 0;
    }
    for (const s of steps) ctx.io.note(`${ws.show(s.from)}\n  → ${ws.show(s.to)}`);
    if (ctx.dryRun) {
      if (ctx.json) emit(ctx, steps);
      else ctx.io.out(`would move ${steps.length} sidecar(s)`);
      return 0;
    }
    if (!(await confirm(ctx, `Move ${steps.length} sidecar(s) into the review folder?`))) return 1;
    const r = await ws.store.migrate(steps);
    if (ctx.json) emit(ctx, r);
    else ctx.io.out(`moved ${r.moved} sidecar(s)` + (r.failed.length ? `; failed: ${r.failed.join("; ")}` : ""));
    return r.failed.length ? 1 : 0;
  },
};

const tui: Command = {
  name: "tui",
  aliases: ["browse", "ui"],
  group: "Workspace",
  vscode: "the Eddie Doc sidebar, in a terminal",
  summary: "Browse documents, mappings and annotations full-screen, and act on them",
  usage: "tui [source.adoc]",
  details:
    "Documents → mappings → annotations, with the selected annotation's comment, source\n" +
    "lines and replies below the list. Keys: ↑↓/jk move, Enter open, Esc/← back, q quit,\n" +
    "? all keys. On an annotation: r resolve, c confirm, a reply, e edit replies, l link to a\n" +
    "line, t triage, m re-match, f fix, A apply all, o open the PDF, b group, / search,\n" +
    "h hide resolved. On a mapping: R re-map, p export report. Set NO_COLOR to disable colour.",
  async run(ctx) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError("tui needs an interactive terminal — use list/show/rounds in scripts");
    }
    const ws = ctx.ws();
    const app = new TuiApp(ws, { color: !process.env.NO_COLOR, home: os.homedir() });
    await app.start(ctx.args.positional[0]);
    // Store notices would scribble over the screen; show them in the footer.
    const note = ctx.io.note;
    ctx.io.note = (line = "") => app.flash(line.replace(/^warning: /, ""), /^warning:/.test(line));
    try {
      await runTerminal(app);
    } finally {
      ctx.io.note = note;
    }
    await ws.store.flush();
    return 0;
  },
};

const config: Command = {
  name: "config",
  group: "Workspace",
  summary: "Show the workspace root and effective settings, and where each came from",
  usage: "config [--json]",
  details:
    "Settings are read, lowest first, from: built-in defaults, .vscode/settings.json\n" +
    "(eddieDoc.* keys), .eddie.json, EDDIE_DOC_* environment variables, then\n" +
    "--set key=value / --review-folder / --threshold flags.",
  async run(ctx) {
    const loaded = ctx.loaded();
    if (ctx.json) {
      emit(ctx, { root: ctx.root(), files: loaded.files, settings: loaded.settings, source: loaded.source });
      return 0;
    }
    ctx.io.out(`root:   ${ctx.root()}`);
    ctx.io.out(`files:  ${loaded.files.join(", ") || "(none)"}`);
    for (const [k, v] of Object.entries(loaded.settings)) {
      ctx.io.out(`  ${k.padEnd(18)} ${JSON.stringify(v).padEnd(28)} ${loaded.source[k as keyof typeof loaded.source]}`);
    }
    return 0;
  },
};

const version: Command = {
  name: "version",
  group: "Workspace",
  summary: "Print the version (the sidecar producer version)",
  usage: "version",
  async run(ctx) {
    ctx.io.out(PRODUCER.version);
    return 0;
  },
};

export const COMMANDS: Command[] = [
  open, append, merge, rounds, describe, remove, remap,
  listCmd, show, resolve, reopen, confirmCmd, relink, remapItem, triage, reply, preview,
  applyCmd, fix, anchor, strip,
  report, stamp, extract, map,
  status, tui, skillsCommand, folder, migrate, config, version,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a sidecar and bind it to its manuscript: the path the caller named, else
 * the one recorded inside the file, else a same-named neighbour (pre-v2).
 */
function loadSession(sidecarPath: string, adocPath?: string): ReviewSession | null {
  try {
    const text = readFileSync(sidecarPath, "utf8");
    const adoc =
      adocPath ?? resolveSourcePath(text, sidecarPath) ?? sidecarPath.replace(/\.review\.json$/i, "") + ".adoc";
    return parseSidecar(text, sidecarPath, adoc);
  } catch {
    return null;
  }
}

function tally(values: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) m[v] = (m[v] ?? 0) + 1;
  return m;
}

