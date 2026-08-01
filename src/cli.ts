/**
 * Standalone harness to validate PDF extraction + source mapping without VS
 * Code. Usage: node dist/cli.js <annotated.pdf> <source.adoc> [--json] [--report] [--lexical]
 */
import { readFileSync } from "node:fs";
import { extractAnnotations } from "./pdf/extract.js";
import { mapAnnotations, effectiveLine } from "./matching/mapper.js";
import { lexicalFallback } from "./matching/lexical.js";
import { renderReport } from "./model/report.js";
import { KIND_LABEL } from "./model/types.js";

async function main() {
  const [pdfPath, adocPath, ...rest] = process.argv.slice(2);
  if (!pdfPath || !adocPath) {
    console.error(
      "usage: cli <annotated.pdf> <source.adoc> [--json] [--report] [--lexical]"
    );
    process.exit(2);
  }
  const asJson = rest.includes("--json");
  const asReport = rest.includes("--report");
  const data = new Uint8Array(readFileSync(pdfPath));
  const source = readFileSync(adocPath, "utf8");

  const annots = await extractAnnotations(data);
  const items = mapAnnotations(annots, source, { threshold: 0.5 });
  if (rest.includes("--lexical")) lexicalFallback(items, source, 0.6);

  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (asReport) {
    const now = new Date().toISOString();
    console.log(
      renderReport({
        version: 2,
        adocPath,
        pdfPath,
        createdAt: now,
        updatedAt: now,
        items,
      })
    );
    return;
  }

  const rawLines = source.split(/\r?\n/);
  console.log(`Extracted ${annots.length} annotation(s):\n`);
  for (const it of items) {
    const line = effectiveLine(it);
    const loc =
      line === Number.MAX_SAFE_INTEGER
        ? "UNMATCHED"
        : `L${line + 1}  (score ${it.match?.score.toFixed(2) ?? "manual"})`;
    console.log(`● [${KIND_LABEL[it.kind]}] p${it.page}  → ${loc}`);
    if (it.anchoredText)
      console.log(`    anchored: "${trunc(it.anchoredText)}"`);
    if (it.comment) console.log(`    comment:  "${trunc(it.comment)}"`);
    if (line !== Number.MAX_SAFE_INTEGER)
      console.log(`    source:   ${trunc(rawLines[line] || "")}`);
    console.log();
  }
}

function trunc(s: string, n = 90): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
