// Keep the sidecar producer stamp in src/core/model/format.ts, the Obsidian
// manifest.json and versions.json equal to package.json's version. Runs as npm's
// "version" lifecycle hook, so the rewritten files are git-added into the same
// commit `npm version` creates.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const file = "src/core/model/format.ts";
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

// Obsidian reads the plugin version from manifest.json and, for older app
// versions, looks up the newest compatible release in versions.json.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
// stderr, NOT stdout: release.sh captures `npm version`'s stdout to read the
// new tag, and lifecycle-hook stdout would corrupt it.
console.error(`sync-producer: ${file}, manifest.json, versions.json -> ${version}`);
