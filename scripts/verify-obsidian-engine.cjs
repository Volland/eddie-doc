#!/usr/bin/env node
/**
 * Run the Obsidian PDF engine — pdfjs's browser build with its worker embedded as
 * a string — against the sample PDF, under Node, and require the same
 * annotations the Node engine finds.
 *
 * Node has no `Worker`, so this exercises the *main-thread fallback* path, the
 * one used when a WebView refuses a Blob worker. It does not exercise the Blob
 * worker itself; only a real Obsidian can. See docs/obsidian-qa.md.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eddie-engine-"));

async function main() {
  const worker = await esbuild.build({
    entryPoints: [path.join(root, "src/hosts/obsidian/pdf/workerEntry.ts")],
    bundle: true, format: "iife", platform: "browser", target: "es2020",
    minify: true, write: false, absWorkingDir: root,
  });
  const src = worker.outputFiles[0].text;

  const entry = path.join(tmp, "entry.ts");
  const q = (p) => JSON.stringify(p.split(path.sep).join("/"));
  fs.writeFileSync(entry, `
    import { readFileSync } from "node:fs";
    import { useObsidianPdfEngine } from ${q(path.join(root, "src/hosts/obsidian/pdf/engine.js"))};
    import { extractAnnotations, readPages } from ${q(path.join(root, "src/core/pdf/extract.js"))};
    (async () => {
      const mode = useObsidianPdfEngine({ loadClassicScript: async (src) => { (0, eval)(src); } });
      const bytes = new Uint8Array(readFileSync(${q(path.join(root, "sample/chapter-01.annotated.pdf"))}));
      const annots = await extractAnnotations(bytes);
      const pages = await readPages(bytes);
      process.stdout.write(JSON.stringify({ mode, kinds: annots.map((a) => a.kind + "@" + a.page), pages: pages.length }));
    })();
  `);
  const out = path.join(tmp, "out.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: "cjs", platform: "node", outfile: out,
    absWorkingDir: root, external: ["obsidian"], logLevel: "error",
    plugins: [{ name: "w", setup(b) {
      b.onResolve({ filter: /^virtual:pdf-worker-source$/ }, (a) => ({ path: a.path, namespace: "w" }));
      b.onLoad({ filter: /.*/, namespace: "w" }, () => ({ contents: "export default " + JSON.stringify(src), loader: "js" }));
    } }],
  });

  const stdout = execFileSync("node", [out], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const got = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const want = ["highlight@2", "strikeout@2", "comment@3", "highlight@4", "strikeout@5"];
  const ok = got.pages === 5 && JSON.stringify(got.kinds) === JSON.stringify(want);
  console.log(`obsidian engine (${got.mode}): ${got.kinds.length} annotations on ${got.pages} pages — ${ok ? "ok" : "MISMATCH"}`);
  if (!ok) {
    console.error("expected", want, "got", got.kinds);
    process.exit(1);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
