#!/usr/bin/env node
/**
 * Run the built CLI on the sample and require exactly the output the code gave
 * before the host/core split.
 *
 * `sample/chapter-01.cli-map.expected.json` is `eddie-doc map --json` produced by the
 * build of git commit 847936f (v1.3.0, before src/core existed), on
 * sample/chapter-01.annotated.pdf and sample/chapter-01.adoc. A byte-for-byte match
 * means extraction, matching and numbering are unchanged by the refactor. If a
 * deliberate change to matching alters the output, regenerate the snapshot from the
 * new build and say why in the commit.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const cli = path.join(root, "dist/cli.js");
if (!fs.existsSync(cli)) {
  console.error("build first: npm run build");
  process.exit(1);
}
const out = execFileSync(
  "node",
  [cli, "map", "sample/chapter-01.annotated.pdf", "sample/chapter-01.adoc", "--json"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
);
const want = fs.readFileSync(path.join(root, "sample/chapter-01.cli-map.expected.json"), "utf8");
if (out !== want) {
  console.error("cli map --json differs from the pre-refactor snapshot");
  const a = out.split("\n"), b = want.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`first difference, line ${i + 1}:\n  got:  ${a[i]}\n  want: ${b[i]}`);
      break;
    }
  }
  process.exit(1);
}
console.log(`cli map --json: identical to the pre-refactor output (${want.length} bytes)`);
