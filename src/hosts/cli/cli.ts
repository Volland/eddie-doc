/**
 * `eddie` — the Eddie Doc command line. Every capability of the VS Code
 * extension, for build scripts, CI, other editors and AI agents.
 *
 *   eddie open   chapter.adoc annotated.pdf     map a review
 *   eddie list   chapter.adoc                   what the editor said, grouped
 *   eddie apply  chapter.adoc                   apply the confident edits
 *   eddie stamp  build/chapter.pdf chapter.adoc  write the review into a fresh render
 *
 * Commands live in `commands.ts`, dispatch in `run.ts`; this file is only the
 * Node entry. Output discipline: results go to stdout, diagnostics to stderr.
 * `console.log` is deliberately unused — the bundle's banner reroutes it to
 * stderr so pdfjs's import-time polyfill warnings cannot corrupt `--json`.
 */
import * as path from "node:path";
import { createInterface } from "node:readline";
import { setUiScheduler } from "../../core/host/progress.js";
import { useNodePdfEngine } from "../node/pdfEngine.js";
import { runCli } from "./run.js";
import type { Io } from "./workspace.js";

// pdf.worker.mjs is copied beside this bundle by esbuild.
declare const __dirname: string;
useNodePdfEngine(path.join(__dirname, "pdf.worker.mjs"));
setUiScheduler((run) => void setTimeout(run, 0));

const io: Io = {
  out: (line = "") => void process.stdout.write(line + "\n"),
  note: (line = "") => void process.stderr.write(line + "\n"),
  interactive: !!process.stdin.isTTY && !!process.stderr.isTTY,
  ask: (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
};

runCli(process.argv.slice(2), io)
  .then((code) => process.exit(code))
  .catch((e) => {
    io.note(String(e && (e as Error).stack ? (e as Error).stack : e));
    process.exit(1);
  });
