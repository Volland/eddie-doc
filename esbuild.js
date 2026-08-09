const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// pdfjs assets that must sit next to the bundle:
//  - pdf.worker.mjs: the Node worker used by the extraction code path.
//  - pdf.min.mjs / pdf.worker.min.mjs: loaded by the PDF-preview webview, which
//    renders pages in a browser context (no native canvas needed).
function copyPdfAssets() {
  const base = path.join(__dirname, "node_modules/pdfjs-dist");
  const files = [
    ["legacy/build/pdf.worker.mjs", "pdf.worker.mjs"],
    ["build/pdf.min.mjs", "pdf.min.mjs"],
    ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ];
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  for (const [from, to] of files) {
    const src = path.join(base, from);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(__dirname, "dist", to));
    }
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

/**
 * Keep stdout clean for the CLI entry points.
 *
 * pdfjs-dist's legacy Node build prints "Cannot polyfill DOMMatrix…" and
 * friends from module-level code that runs at *import* time — before any
 * `verbosity: 0` we pass to getDocument can suppress it, and before any
 * statement in our own entry file. Those lines land on stdout and corrupt
 * `--json` output and anything a shell pipeline tries to parse.
 *
 * A banner runs ahead of all bundled module code, which is the only place early
 * enough to intercept it. Diagnostics still reach the user — they are just
 * routed to stderr, where they belong.
 */
const STDOUT_GUARD = `
(() => {
  const toStderr = (...a) => { try { process.stderr.write(a.join(" ") + "\\n"); } catch {} };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
})();
`;

async function main() {
  copyPdfAssets();
  const entries = [
    { entry: "src/extension.ts", outfile: "dist/extension.js", external: ["vscode"] },
    // CLI entries write machine-readable output; guard their stdout.
    { entry: "src/cli.ts", outfile: "dist/cli.js", external: [], guardStdout: true },
    { entry: "src/benchmark/main.ts", outfile: "dist/bench.js", external: [], guardStdout: true },
  ].filter((e) => fs.existsSync(path.join(__dirname, e.entry)));

  const contexts = await Promise.all(
    entries.map((e) =>
      esbuild.context({
        ...common,
        entryPoints: [e.entry],
        outfile: e.outfile,
        external: e.external,
        ...(e.guardStdout ? { banner: { js: STDOUT_GUARD } } : {}),
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
