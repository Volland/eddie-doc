/**
 * Eddie Doc command line — the half of the workflow that lives in a build
 * script rather than in the editor.
 *
 *   map    <annotated.pdf> <source.adoc>   inspect extraction + matching
 *   stamp  <fresh.pdf> --review <sidecar>  write annotations into a new render
 *   anchor <source.adoc> --review <sidecar> inject `// eddie:` markers
 *   strip  <source.adoc>                   remove them again
 *
 * Output discipline: results go to stdout via {@link out}, diagnostics to
 * stderr via {@link note}. `console.log` is deliberately unused — the bundle's
 * banner reroutes it to stderr so pdfjs's import-time polyfill warnings cannot
 * corrupt `--json` output for a shell pipeline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { extractAnnotations, readPages } from "./pdf/extract.js";
import { mapAnnotations, effectiveLine } from "./matching/mapper.js";
import { lexicalFallback } from "./matching/lexical.js";
import { renderReport } from "./model/report.js";
import {
  defaultRevision,
  parse as parseSidecar,
  resolveSourcePath,
  serialize,
} from "./model/format.js";
import { KIND_LABEL, type ReviewSession } from "./model/types.js";
import { anchorItems, type AnchorResult } from "./pdf/anchor.js";
import { stampPdf } from "./pdf/stamp.js";
import {
  describeAnchor,
  findMarkers,
  injectMarkers,
  stripMarkers,
  type MarkerTarget,
} from "./source/markers.js";

const USAGE = `eddie-doc — AsciiDoc PDF review

  map    <annotated.pdf> <source.adoc> [--json] [--report] [--lexical]
  stamp  <fresh.pdf> --review <sidecar.json>... [-o out.pdf]
                     [--no-resolved] [--fail-on-unstamped]
  anchor <source.adoc> --review <sidecar.json> [--dry-run]
  strip  <source.adoc> [--dry-run]
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const verb = argv[0];

  // `map` is the historical default: keep bare positional usage working.
  if (!verb) {
    note(USAGE);
    return 2;
  }
  switch (verb) {
    case "stamp":
      return stampCmd(argv.slice(1));
    case "anchor":
      return anchorCmd(argv.slice(1));
    case "strip":
      return stripCmd(argv.slice(1));
    case "map":
      return mapCmd(argv.slice(1));
    case "-h":
    case "--help":
      out(USAGE);
      return 0;
    default:
      return mapCmd(argv);
  }
}

// ---------------------------------------------------------------------------
// map — the original harness
// ---------------------------------------------------------------------------

async function mapCmd(args: string[]): Promise<number> {
  const [pdfPath, adocPath, ...rest] = args;
  if (!pdfPath || !adocPath) {
    note(USAGE);
    return 2;
  }
  const data = new Uint8Array(readFileSync(pdfPath));
  const source = readFileSync(adocPath, "utf8");

  const annots = await extractAnnotations(data);
  const items = mapAnnotations(annots, source, { threshold: 0.5 });
  if (rest.includes("--lexical")) lexicalFallback(items, source, 0.6);

  if (rest.includes("--json")) {
    out(JSON.stringify(items, null, 2));
    return 0;
  }
  if (rest.includes("--report")) {
    const now = new Date().toISOString();
    out(
      renderReport({
        version: 3,
        // `map` is a throwaway harness: it never writes a sidecar, so this
        // session exists only to be rendered.
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
  out(`Extracted ${annots.length} annotation(s):\n`);
  for (const it of items) {
    const line = effectiveLine(it);
    const loc =
      line === Number.MAX_SAFE_INTEGER
        ? "UNMATCHED"
        : `L${line + 1}  (score ${it.match?.score.toFixed(2) ?? "manual"})`;
    out(`● [${KIND_LABEL[it.kind]}] p${it.page}  → ${loc}`);
    if (it.anchoredText) out(`    anchored: "${trunc(it.anchoredText)}"`);
    if (it.comment) out(`    comment:  "${trunc(it.comment)}"`);
    if (line !== Number.MAX_SAFE_INTEGER)
      out(`    source:   ${trunc(rawLines[line] || "")}`);
    out();
  }
  return 0;
}

// ---------------------------------------------------------------------------
// stamp — put the review back into a fresh render
// ---------------------------------------------------------------------------

async function stampCmd(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const pdfPath = flags.positional[0];
  if (!pdfPath || !flags.review.length) {
    note("usage: stamp <fresh.pdf> --review <sidecar.json>... [-o out.pdf]");
    return 2;
  }
  const outPath =
    flags.out ?? pdfPath.replace(/\.pdf$/i, "") + ".reviewed.pdf";
  if (path.resolve(outPath) === path.resolve(pdfPath)) {
    note("refusing to overwrite the clean render in place — pass -o");
    return 2;
  }

  const bytes = new Uint8Array(readFileSync(pdfPath));
  const pages = await readPages(bytes);
  note(`${path.basename(pdfPath)}: ${pages.length} page(s)`);

  const all: AnchorResult = { anchored: [], unstamped: [] };
  for (const sidecarPath of flags.review) {
    const session = loadSession(sidecarPath);
    if (!session) {
      note(`  ! ${path.basename(sidecarPath)}: unreadable, skipped`);
      continue;
    }
    const source = readFileSync(session.adocPath, "utf8");
    const res = anchorItems(session.items, source, pages);
    all.anchored.push(...res.anchored);
    all.unstamped.push(...res.unstamped);
    note(
      `  ${path.basename(sidecarPath)}: ${res.anchored.length} placed, ` +
        `${res.unstamped.length} un-stampable of ${session.items.length}`
    );
  }

  const result = await stampPdf(bytes, all.anchored, {
    includeResolved: !flags.noResolved,
  });
  writeFileSync(outPath, result.bytes);

  const byPrecision = tally(all.anchored.map((a) => a.precision));
  out(`${outPath}`);
  note(
    `wrote ${result.marks} mark(s) and ${result.replies} repl(ies) — ` +
      `${byPrecision.exact ?? 0} exact, ${byPrecision.line ?? 0} line-level, ` +
      `${byPrecision.block ?? 0} block` +
      (result.skippedResolved ? `, ${result.skippedResolved} resolved skipped` : "")
  );
  if (all.unstamped.length) {
    note(`\n${all.unstamped.length} annotation(s) could not be placed:`);
    for (const u of all.unstamped) {
      note(`  · [${KIND_LABEL[u.item.kind]}] ${trunc(u.item.comment || u.item.anchoredText, 60)}`);
      note(`      ${u.reason}`);
    }
  }
  return flags.failOnUnstamped && all.unstamped.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// anchor / strip — durable source markers
// ---------------------------------------------------------------------------

function anchorCmd(args: string[]): number {
  const flags = parseFlags(args);
  const adocPath = flags.positional[0];
  const sidecarPath = flags.review[0];
  if (!adocPath || !sidecarPath) {
    note("usage: anchor <source.adoc> --review <sidecar.json> [--dry-run]");
    return 2;
  }
  const session = loadSession(sidecarPath, adocPath);
  if (!session) {
    note(`cannot read ${sidecarPath}`);
    return 1;
  }
  const before = readFileSync(adocPath, "utf8");

  const targets: MarkerTarget[] = [];
  for (const it of session.items) {
    const line = effectiveLine(it);
    if (line !== Number.MAX_SAFE_INTEGER) targets.push({ itemId: it.id, line });
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

  if (flags.dryRun) {
    note(
      `would insert ${res.inserted} marker(s) and anchor ${anchored} annotation(s)`
    );
    return 0;
  }
  writeFileSync(adocPath, res.source);
  session.updatedAt = new Date().toISOString();
  writeFileSync(sidecarPath, serialize(session, sidecarPath), "utf8");
  out(`${adocPath}`);
  note(`inserted ${res.inserted} marker(s); anchored ${anchored} annotation(s)`);
  return 0;
}

function stripCmd(args: string[]): number {
  const flags = parseFlags(args);
  const adocPath = flags.positional[0];
  if (!adocPath) {
    note("usage: strip <source.adoc> [--dry-run]");
    return 2;
  }
  const before = readFileSync(adocPath, "utf8");
  const after = stripMarkers(before);
  const removed = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
  if (flags.dryRun) {
    note(`would remove ${removed} marker(s)`);
    return 0;
  }
  if (after !== before) writeFileSync(adocPath, after);
  out(`${adocPath}`);
  note(`removed ${removed} marker(s)`);
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Flags {
  positional: string[];
  review: string[];
  out?: string;
  noResolved: boolean;
  failOnUnstamped: boolean;
  dryRun: boolean;
}

function parseFlags(args: string[]): Flags {
  const f: Flags = {
    positional: [],
    review: [],
    noResolved: false,
    failOnUnstamped: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--review") f.review.push(args[++i]);
    else if (a === "-o" || a === "--out") f.out = args[++i];
    else if (a === "--no-resolved") f.noResolved = true;
    else if (a === "--fail-on-unstamped") f.failOnUnstamped = true;
    else if (a === "--dry-run") f.dryRun = true;
    else if (!a.startsWith("-")) f.positional.push(a);
  }
  return f;
}

/**
 * Read a sidecar and bind it to its manuscript: the path the caller named, else
 * the one recorded inside the file (relative to it, so a sidecar in the review
 * folder resolves correctly), else the pre-v2 convention of a same-named
 * neighbour.
 */
function loadSession(
  sidecarPath: string,
  adocPath?: string
): ReviewSession | null {
  try {
    const text = readFileSync(sidecarPath, "utf8");
    const adoc =
      adocPath ??
      resolveSourcePath(text, sidecarPath) ??
      sidecarPath.replace(/\.review\.json$/i, "") + ".adoc";
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

/** Write a result line to stdout. The only channel machine output may use. */
function out(line = ""): void {
  process.stdout.write(line + "\n");
}

/** Write a human-facing diagnostic to stderr, never stdout. */
function note(line = ""): void {
  process.stderr.write(line + "\n");
}

function trunc(s: string, n = 90): string {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    note(String(e && (e as Error).stack ? (e as Error).stack : e));
    process.exit(1);
  });
