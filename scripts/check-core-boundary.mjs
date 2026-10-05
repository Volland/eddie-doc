#!/usr/bin/env node
// Fails when host-neutral code imports a host or a Node-only module.
//
//   node scripts/check-core-boundary.mjs          check src/core (the gate)
//   node scripts/check-core-boundary.mjs --report report every offending file
//                                                  under src/, for planning
//
// src/core runs unchanged inside VS Code, Obsidian (desktop AND mobile, which
// has no Node) and the CLI, so it may not import `vscode`, `obsidian`, Electron,
// or Node's fs / path / crypto / child_process / os / url / worker_threads.
// Type-only imports are still flagged: they would drag the host's types into the
// core's compilation and hide the next real leak.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const report = process.argv.includes("--report");
// What is checked, and what each may not import. The core runs in every host;
// the Obsidian host's pure/ folder is the logic that is unit-tested without
// Obsidian, so it may use neither `obsidian` nor Node (CodeMirror state is fine).
const TARGETS = report
  ? [{ dir: join(root, "src"), forbidden: null }]
  : [
      { dir: join(root, "src", "core"), forbidden: null },
      {
        dir: join(root, "src", "hosts", "obsidian", "pure"),
        forbidden:
          /^(?:node:)?(?:fs|fs\/promises|path|crypto|child_process|os|url|worker_threads|stream|http|https|net|zlib|buffer|process)$|^(?:vscode|obsidian|electron)$/,
      },
    ];

const FORBIDDEN =
  /^(?:node:)?(?:fs|fs\/promises|path|crypto|child_process|os|url|worker_threads|stream|http|https|net|zlib|buffer|process)$|^(?:vscode|obsidian|electron)$|^@codemirror\/|^@lezer\//;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) {
      yield p;
    }
  }
}

// import x from "m" | import "m" | export ... from "m" | import("m") | require("m")
const SPEC =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

const offenders = [];
for (const target of TARGETS) {
  const base = target.dir;
  const rule = target.forbidden ?? FORBIDDEN;
  try {
    statSync(base);
  } catch {
    console.log(`check-core-boundary: ${relative(root, base)} does not exist yet`);
    if (!report) process.exit(1);
    continue;
  }
  for (const file of walk(base)) {
    const text = readFileSync(file, "utf8")
      // ignore specifiers that only appear in comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const bad = new Set();
    for (const m of text.matchAll(SPEC)) {
      if (rule.test(m[1])) bad.add(m[1]);
    }
    if (bad.size) offenders.push([relative(root, file), [...bad].sort()]);
  }
}

if (!offenders.length) {
  console.log(`check-core-boundary: ok (${TARGETS.map((t) => relative(root, t.dir)).join(", ")})`);
  process.exit(0);
}
for (const [f, mods] of offenders) console.log(`${f}: ${mods.join(", ")}`);
if (report) process.exit(0);
console.error(
  `\ncheck-core-boundary: ${offenders.length} file(s) import a host or a Node-only module where they may not.`
);
process.exit(1);
