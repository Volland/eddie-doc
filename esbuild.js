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

/**
 * Obsidian plugin: one `main.js` (plus manifest and styles) that must run on
 * desktop AND mobile, where there is no Node. Three things follow:
 *  - `obsidian`, `electron` and CodeMirror are Obsidian's own; bundling a second
 *    copy of CodeMirror breaks `instanceof` checks and facet identity.
 *  - pdfjs's worker cannot be loaded from a file inside the plugin on mobile, so
 *    it is built as a classic script and embedded in `main.js` as a string.
 *  - no Node builtin may survive in the output; the build fails if one does.
 */
async function buildObsidian() {
  const worker = await esbuild.build({
    entryPoints: ["src/hosts/obsidian/pdf/workerEntry.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    logLevel: "warning",
  });
  const workerSource = worker.outputFiles[0].text;

  /** `import src from "virtual:pdf-worker-source"` → the worker script, as text. */
  const embedWorker = {
    name: "embed-pdf-worker",
    setup(b) {
      b.onResolve({ filter: /^virtual:pdf-worker-source$/ }, (a) => ({
        path: a.path,
        namespace: "pdf-worker",
      }));
      b.onLoad({ filter: /.*/, namespace: "pdf-worker" }, () => ({
        contents: `export default ${JSON.stringify(workerSource)};`,
        loader: "js",
      }));
    },
  };

  const out = path.join(__dirname, "dist", "obsidian");
  fs.mkdirSync(out, { recursive: true });
  const result = await esbuild.build({
    entryPoints: ["src/hosts/obsidian/main.ts"],
    outfile: path.join(out, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    plugins: [embedWorker],
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    minify: production,
    sourcemap: production ? false : "inline",
    legalComments: "none",
    metafile: true,
    logLevel: "info",
  });

  // Fail the build if anything Node-only was pulled into the bundle.
  const text = fs.readFileSync(path.join(out, "main.js"), "utf8");
  const NODE = ["fs", "path", "os", "crypto", "child_process", "worker_threads", "module", "url", "stream", "http", "https", "zlib", "net", "canvas"];
  const leaked = NODE.filter((m) =>
    new RegExp(`require\\(["'](node:)?${m}["']\\)`).test(text)
  );
  if (leaked.length) {
    throw new Error(
      `obsidian bundle requires Node modules (${leaked.join(", ")}); they do not exist on mobile.`
    );
  }
  const kb = Math.round(fs.statSync(path.join(out, "main.js")).size / 1024);
  if (kb > 4096) console.warn(`[obsidian] main.js is ${kb} KB — check what grew.`);

  // Manifest carries the package version; styles are copied as they are.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.copyFileSync(
    path.join(__dirname, "src/hosts/obsidian/styles.css"),
    path.join(out, "styles.css")
  );
  return result;
}

async function main() {
  if (process.argv.includes("--obsidian-only")) {
    await buildObsidian();
    return;
  }
  copyPdfAssets();
  const entries = [
    { entry: "src/hosts/vscode/extension.ts", outfile: "dist/extension.js", external: ["vscode"] },
    // CLI entries write machine-readable output; guard their stdout.
    { entry: "src/hosts/cli/cli.ts", outfile: "dist/cli.js", external: [], guardStdout: true },
    { entry: "src/hosts/cli/benchmark/main.ts", outfile: "dist/bench.js", external: [], guardStdout: true },
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
  if (!process.argv.includes("--no-obsidian")) await buildObsidian();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
