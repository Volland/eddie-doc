const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// pdfjs needs its worker file available next to the bundle; copy the prebuilt
// legacy ESM worker into dist/ and point GlobalWorkerOptions.workerSrc at it.
function copyWorker() {
  const src = path.join(
    __dirname,
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
  );
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(__dirname, "dist/pdf.worker.mjs"));
  }
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // pdfjs-dist ships as ESM; esbuild bundles it into our CJS output.
  // Disabling worker use keeps it single-threaded in the Node/extension host.
  define: { "globalThis.__EDDIE_DOC__": "true" },
};

async function main() {
  copyWorker();
  const entries = [
    { entry: "src/extension.ts", outfile: "dist/extension.js", external: ["vscode"] },
    { entry: "src/cli.ts", outfile: "dist/cli.js", external: [] },
  ].filter((e) => fs.existsSync(path.join(__dirname, e.entry)));

  const contexts = await Promise.all(
    entries.map((e) =>
      esbuild.context({
        ...common,
        entryPoints: [e.entry],
        outfile: e.outfile,
        external: e.external,
      })
    )
  );

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
