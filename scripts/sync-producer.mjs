// Keep the sidecar producer stamp in src/model/format.ts equal to
// package.json's version. Runs as npm's "version" lifecycle hook, so the
// rewritten file is git-added into the same commit `npm version` creates.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const file = "src/model/format.ts";
const src = readFileSync(file, "utf8");
const out = src.replace(
  /(PRODUCER = \{ name: "eddie-doc", version: ")[^"]+("\s*\})/,
  `$1${version}$2`
);
if (out === src && !src.includes(`version: "${version}"`)) {
  console.error(`sync-producer: could not find PRODUCER stamp in ${file}`);
  process.exit(1);
}
writeFileSync(file, out);
// stderr, NOT stdout: release.sh captures `npm version`'s stdout to read the
// new tag, and lifecycle-hook stdout would corrupt it.
console.error(`sync-producer: ${file} -> ${version}`);
