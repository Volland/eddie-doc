import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The `eddie` command line, shipped inside the extension.
 *
 * The VSIX already carries `dist/cli.js` and its pdfjs worker. On activation
 * they are copied to a stable folder in global storage — the extension's own
 * folder is renamed on every update, which would break a link into it — and a
 * small `eddie` launcher is written beside them. The launcher runs the CLI on
 * VS Code's own runtime (`ELECTRON_RUN_AS_NODE`), so it works on a machine with
 * no Node installed, falling back to `node` if VS Code has since moved.
 *
 * That folder is put on the PATH of every integrated terminal, and
 * `Eddie Doc: Install 'eddie' Command in PATH` links it into `~/.local/bin` for
 * shells outside VS Code.
 */
const FILES = ["cli.js", "pdf.worker.mjs"];

export interface CliInstall {
  binDir: string;
  launcher: string;
}

/** Single-quote for POSIX sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function writeIfChanged(file: string, text: string, mode?: number): void {
  try {
    if (fs.readFileSync(file, "utf8") === text) return;
  } catch {
    /* missing: write it */
  }
  fs.writeFileSync(file, text, { encoding: "utf8", mode });
}

/** Copy the bundled CLI into global storage and write the launchers. */
export function installCliFiles(context: vscode.ExtensionContext): CliInstall | undefined {
  const dist = path.join(context.extensionPath, "dist");
  if (!fs.existsSync(path.join(dist, "cli.js"))) return undefined;
  const binDir = path.join(context.globalStorageUri.fsPath, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const version = String(context.extension.packageJSON.version ?? "");
  const stamp = path.join(binDir, "VERSION");
  let installed = "";
  try {
    installed = fs.readFileSync(stamp, "utf8").trim();
  } catch {
    /* first install */
  }
  if (installed !== version || FILES.some((f) => !fs.existsSync(path.join(binDir, f)))) {
    for (const f of FILES) fs.copyFileSync(path.join(dist, f), path.join(binDir, f));
    fs.writeFileSync(stamp, version + "\n");
  }

  const cli = path.join(binDir, "cli.js");
  const runtime = process.execPath;
  const sh =
    "#!/bin/sh\n" +
    "# Eddie Doc CLI launcher, written by the VS Code extension. Do not edit.\n" +
    `CLI=${shq(cli)}\n` +
    `RUNTIME=${shq(runtime)}\n` +
    'if [ -n "$EDDIE_NODE" ]; then exec "$EDDIE_NODE" "$CLI" "$@"; fi\n' +
    'if [ -x "$RUNTIME" ]; then ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$CLI" "$@"; fi\n' +
    'exec node "$CLI" "$@"\n';
  const launcher = path.join(binDir, "eddie");
  writeIfChanged(launcher, sh, 0o755);
  fs.chmodSync(launcher, 0o755);
  writeIfChanged(
    path.join(binDir, "eddie.cmd"),
    "@echo off\r\n" +
      'if defined EDDIE_NODE ( "%EDDIE_NODE%" "' + cli + '" %* & exit /b %ERRORLEVEL% )\r\n' +
      "setlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n" +
      `"${runtime}" "${cli}" %*\r\n`
  );
  return { binDir, launcher };
}

/** Put the launcher folder on the PATH of integrated terminals. */
export function exposeOnTerminalPath(context: vscode.ExtensionContext, install: CliInstall): void {
  const env = context.environmentVariableCollection;
  const enabled = vscode.workspace
    .getConfiguration("eddieDoc")
    .get<boolean>("cli.addToTerminalPath", true);
  env.clear();
  if (!enabled) return;
  env.description = "Adds the `eddie` command (Eddie Doc CLI) to the terminal.";
  env.prepend("PATH", install.binDir + path.delimiter);
}

/** `Install 'eddie' Command in PATH`: link the launcher into ~/.local/bin. */
export async function installOnShellPath(install: CliInstall): Promise<void> {
  if (process.platform === "win32") {
    const pick = await vscode.window.showInformationMessage(
      `Eddie Doc: 'eddie' is on the PATH of VS Code terminals. For other shells, add this folder to your PATH:\n${install.binDir}`,
      "Copy Folder Path"
    );
    if (pick) await vscode.env.clipboard.writeText(install.binDir);
    return;
  }
  const dir = path.join(os.homedir(), ".local", "bin");
  const target = path.join(dir, "eddie");
  try {
    fs.mkdirSync(dir, { recursive: true });
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(target);
    } catch {
      /* nothing there */
    }
    if (existing) {
      const ours =
        existing.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(target)) === install.launcher;
      if (ours) {
        vscode.window.showInformationMessage(`Eddie Doc: 'eddie' is already installed at ${target}.`);
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `${target} already exists. Replace it with the Eddie Doc CLI?`,
        { modal: true },
        "Replace"
      );
      if (pick !== "Replace") return;
      fs.unlinkSync(target);
    }
    fs.symlinkSync(install.launcher, target);
  } catch (e) {
    vscode.window.showErrorMessage(`Eddie Doc: could not install 'eddie' — ${String(e)}`);
    return;
  }
  const onPath = (process.env.PATH ?? "").split(path.delimiter).some((p) => path.resolve(p) === dir);
  vscode.window.showInformationMessage(
    onPath
      ? `Eddie Doc: installed 'eddie' at ${target}. Run 'eddie help' in any shell.`
      : `Eddie Doc: installed 'eddie' at ${target}. Add ~/.local/bin to your PATH to use it outside VS Code.`
  );
}

/** A terminal in the workspace with `eddie` ready, showing the review status. */
export function openCliTerminal(install: CliInstall): void {
  const term = vscode.window.createTerminal({
    name: "Eddie Doc",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    env: { PATH: install.binDir + path.delimiter + (process.env.PATH ?? "") },
  });
  term.show();
  term.sendText("eddie status");
}
