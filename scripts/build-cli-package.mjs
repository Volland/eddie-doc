#!/usr/bin/env node
/**
 * Assemble the `@eddie-doc/cli` npm package in packages/cli from the build.
 *
 *   node scripts/build-cli-package.mjs           copy dist/ into the package
 *   node scripts/build-cli-package.mjs --check   fail if the package is incomplete
 *
 * The CLI is one esbuild bundle with pdfjs and pdf-lib inside it, so the package
 * has no runtime dependencies: just cli.js and the pdfjs worker it loads from
 * beside itself. The version is the extension's, so a sidecar's producer
 * version names the same release whichever host wrote it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages/cli");
const FILES = ["cli.js", "pdf.worker.mjs"];

const fail = (msg) => {
  console.error(`[cli-package] ${msg}`);
  process.exit(1);
};

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const pkgFile = path.join(pkgDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));

if (process.argv.includes("--check")) {
  for (const f of FILES) {
    if (!fs.existsSync(path.join(pkgDir, "dist", f))) fail(`missing dist/${f} — run: npm run build:cli-package`);
  }
  if (!fs.existsSync(path.join(pkgDir, "LICENSE"))) fail("missing LICENSE — run: npm run build:cli-package");
  if (pkg.version !== version) fail(`version ${pkg.version} != extension ${version} — run: npm run build:cli-package`);
  const head = fs.readFileSync(path.join(pkgDir, "dist/cli.js"), "utf8").slice(0, 32);
  if (!head.startsWith("#!/usr/bin/env node")) fail("dist/cli.js has no shebang");
  process.exit(0);
}

for (const f of FILES) {
  const src = path.join(root, "dist", f);
  if (!fs.existsSync(src)) fail(`dist/${f} not built — run: npm run build`);
}
fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(root, "dist", f), path.join(pkgDir, "dist", f));
fs.chmodSync(path.join(pkgDir, "dist/cli.js"), 0o755);
fs.copyFileSync(path.join(root, "LICENSE"), path.join(pkgDir, "LICENSE"));
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`[cli-package] @eddie-doc/cli@${version} ready in packages/cli`);
