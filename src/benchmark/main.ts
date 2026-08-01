/**
 * Matching-quality benchmark: run the real extraction + mapping pipeline over
 * golden corpora and gate on the result, so matcher changes are measured
 * instead of eyeballed.
 *
 * Usage:
 *   node dist/bench.js [golden.json ...] [--threshold 0.5] [--lexical] [--json]
 *
 * With no files, runs every `*.golden.json` under `sample/`. A golden file
 * lives next to the fixtures it references:
 *
 *   { "source": "chapter-01.adoc",
 *     "pdf": "chapter-01.annotated.pdf",
 *     "cases": [ { "key": "Cut — repeats the intro.", "lines": [35, 35] } ] }
 *
 * Exit code 0 when every case is correct, 1 otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { lexicalFallback } from "../matching/lexical.js";
import { mapAnnotations } from "../matching/mapper.js";
import { extractAnnotations } from "../pdf/extract.js";
import { scoreItems, type BenchSummary, type GoldenCase } from "./score.js";

interface GoldenFile {
  source: string;
  pdf: string;
  cases: GoldenCase[];
}

const STATUS_ICON: Record<string, string> = {
  correct: "✓",
  "wrong-line": "✗",
  missed: "✗",
  "unexpected-match": "✗",
  "annotation-missing": "✗",
};

async function runGolden(
  goldenPath: string,
  threshold: number,
  lexical: boolean
): Promise<BenchSummary> {
  const dir = path.dirname(goldenPath);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenFile;
  const source = readFileSync(path.resolve(dir, golden.source), "utf8");
  const pdf = new Uint8Array(readFileSync(path.resolve(dir, golden.pdf)));

  const annots = await extractAnnotations(pdf);
  const items = mapAnnotations(annots, source, { threshold });
  if (lexical) lexicalFallback(items, source, 0.6);

  return scoreItems(items, golden.cases);
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const lexical = args.includes("--lexical");
  const tIdx = args.indexOf("--threshold");
  const threshold = tIdx >= 0 ? Number(args[tIdx + 1]) : 0.5;
  const files = args.filter(
    (a, i) => !a.startsWith("--") && (tIdx < 0 || i !== tIdx + 1)
  );

  if (files.length === 0) {
    const sampleDir = path.resolve("sample");
    for (const f of readdirSync(sampleDir)) {
      if (f.endsWith(".golden.json")) files.push(path.join(sampleDir, f));
    }
  }
  if (files.length === 0) {
    console.error("bench: no golden files found (looked in ./sample)");
    process.exit(2);
  }

  let totalCases = 0;
  let totalCorrect = 0;
  const perFile: Record<string, BenchSummary> = {};

  for (const f of files) {
    const summary = await runGolden(f, threshold, lexical);
    perFile[f] = summary;
    totalCases += summary.total;
    totalCorrect += summary.correct;

    if (!asJson) {
      console.log(`\n${path.basename(f)}  (threshold ${threshold}${lexical ? ", +lexical" : ""})`);
      for (const r of summary.results) {
        const icon = STATUS_ICON[r.status] ?? "?";
        const tail =
          r.status === "correct"
            ? `→ ${r.got}`
            : `→ ${r.got}, expected ${r.expected}  [${r.status}]`;
        console.log(`  ${icon} "${r.key}" ${tail}`);
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ threshold, lexical, files: perFile }, null, 2));
  } else {
    console.log(
      `\n${totalCorrect}/${totalCases} correct` +
        (totalCorrect === totalCases ? "" : ` — ${totalCases - totalCorrect} failing`)
    );
  }
  process.exit(totalCorrect === totalCases ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
