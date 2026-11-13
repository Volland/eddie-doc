/**
 * Operations shared by the CLI's one-shot commands and its interactive TUI, so
 * both write a report to the same place and open files the same way.
 */
import { mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { isSessionStale, renderReport } from "../../core/model/report.js";
import { documentFolder, mappingReportPath, pdfFolder } from "../../core/model/layout.js";
import type { ReviewSession } from "../../core/model/types.js";
import type { Workspace } from "./workspace.js";

/** Where a generated file goes, by the `stampOutput` / `reportOutput` settings. */
export function outputPath(
  ws: Workspace,
  session: ReviewSession,
  mode: string,
  fallback: string,
  kind: "pdf" | "report"
): string {
  if (mode !== "reviewFolder") return fallback;
  const folder = documentFolder(ws.store.layoutConfig, session.adocPath);
  if (!folder) return fallback;
  if (kind === "report") return mappingReportPath(folder, session.revision.id, session.mapping.id);
  return path.join(pdfFolder(folder, session.revision.id), path.basename(fallback));
}

/** Render a mapping's Markdown report. */
export async function renderSessionReport(
  ws: Workspace,
  session: ReviewSession,
  includeResolved = true
): Promise<string> {
  return renderReport(session, {
    highConfidence: ws.settings.highConfidence,
    includeResolved,
    stale: await isSessionStale(session, ws.storage),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Write a mapping's report where `reportOutput` says (or to `outPath`) and
 * record it on the mapping, as the editor's Export Review Report does.
 */
export async function writeReport(
  ws: Workspace,
  session: ReviewSession,
  opts: { outPath?: string; includeResolved?: boolean } = {}
): Promise<string> {
  const md = await renderSessionReport(ws, session, opts.includeResolved ?? true);
  const outPath =
    opts.outPath ??
    outputPath(
      ws,
      session,
      ws.settings.reportOutput,
      session.adocPath.replace(/\.(adoc|asciidoc)$/i, "") + ".review.md",
      "report"
    );
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf8");
  ws.store.recordArtifact(session.sidecarPath, {
    kind: "report",
    path: outPath,
    createdAt: new Date().toISOString(),
  });
  await ws.store.flush();
  return outPath;
}

/** Open a file or folder with the platform's default application. */
export function openFile(target: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// -- agent skills ---------------------------------------------------------------

/** Remove empty skill folders left behind by {@link removeSkills}. */
export function tidySkillFolders(files: string[]): void {
  const dirs = [...new Set(files.map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    for (let cur = d; ; cur = path.dirname(cur)) {
      if (/[\\/]\.?[a-z]+[\\/]skills$/i.test(cur)) break; // never remove a tool's skills folder itself
      try {
        if (readdirSync(cur).length) break;
        rmdirSync(cur);
      } catch {
        break;
      }
    }
  }
}
