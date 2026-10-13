/**
 * Dispatch one CLI invocation: global flags, the command, help, and the error
 * discipline (usage errors exit 2, expected failures exit 1, both without a
 * stack trace). Separate from the entry file so tests can drive it in-process.
 */
import { parseArgs, all, has, str, UsageError, type ArgSpec } from "./args.js";
import { findWorkspaceRoot, loadSettings, splitAssignment, type LoadedSettings } from "./config.js";
import { COMMANDS, findCommand, GROUPS, type Command, type Ctx } from "./commands.js";
import { CliError, Workspace, type Io } from "./workspace.js";
import { PRODUCER } from "../../core/model/format.js";

const GLOBAL_VALUES = ["root", "set", "review-folder", "threshold", "mapping", "round", "author", "out"];
const GLOBAL_ALIASES: Record<string, string> = {
  o: "out",
  h: "help",
  y: "yes",
  q: "quiet",
  m: "mapping",
  r: "round",
};

const GLOBAL_HELP = `Global options:
  --root DIR            workspace root (default: nearest folder with .eddie.json,
                        .vscode, .eddie or .git above the current directory)
  -m, --mapping M       which mapping: id, rev-N/id, label, origin or sidecar path
  -r, --round N         which round (default: the newest mapping of the document)
  --review-folder DIR   override eddieDoc.reviewFolder ('' = sidecar beside .adoc)
  --threshold X         override eddieDoc.matchThreshold (0-1)
  --set key=value       override any eddieDoc.* setting (repeatable)
  --author NAME         name stamped on replies
  --json                machine-readable output on stdout
  --dry-run             show what would change, change nothing
  -y, --yes             do not ask before changing the manuscript
  -q, --quiet           fewer notices on stderr
  -h, --help            help for a command`;

export function usage(): string {
  const lines = [
    `eddie ${PRODUCER.version} — map PDF review annotations back onto AsciiDoc sources`,
    "",
    "Usage: eddie <command> [arguments] [options]",
  ];
  for (const g of GROUPS) {
    lines.push("", `${g}:`);
    for (const c of COMMANDS.filter((x) => x.group === g)) {
      lines.push(`  ${c.name.padEnd(12)} ${c.summary}`);
    }
  }
  lines.push("", GLOBAL_HELP, "", "Run `eddie help <command>` for a command's arguments.");
  return lines.join("\n");
}

export function commandHelp(c: Command): string {
  const lines = [
    `eddie ${c.name} — ${c.summary}`,
    "",
    ...c.usage.split("\n").map((l, i) => (i === 0 ? `Usage: eddie ${l}` : `       ${l.startsWith(" ") ? l : "eddie " + l}`)),
  ];
  if (c.aliases?.length) lines.push("", `Aliases: ${c.aliases.join(", ")}`);
  if (c.vscode) lines.push(`VS Code: ${c.vscode}`);
  if (c.details) lines.push("", c.details);
  lines.push("", GLOBAL_HELP);
  return lines.join("\n");
}

export interface RunOptions {
  /** Where to start looking for the workspace root (default: cwd). */
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function runCli(argv: string[], io: Io, opts: RunOptions = {}): Promise<number> {
  const verb = argv[0];
  if (!verb) {
    io.note(usage());
    return 2;
  }
  if (verb === "-h" || verb === "--help" || verb === "help") {
    const topic = verb === "help" ? argv[1] : undefined;
    const c = topic ? findCommand(topic) : undefined;
    if (topic && !c) {
      io.note(`unknown command "${topic}"`);
      return 2;
    }
    io.out(c ? commandHelp(c) : usage());
    return 0;
  }
  if (verb === "-v" || verb === "--version") {
    io.out(PRODUCER.version);
    return 0;
  }

  // `eddie a.pdf b.adoc` is the historical spelling of `eddie map a.pdf b.adoc`.
  let command = findCommand(verb);
  let rest = argv.slice(1);
  if (!command && /\.pdf$/i.test(verb)) {
    command = findCommand("map")!;
    rest = argv;
  }
  if (!command) {
    io.note(`unknown command "${verb}" — run: eddie help`);
    return 2;
  }

  try {
    const spec: ArgSpec = {
      values: [...GLOBAL_VALUES, ...(command.spec?.values ?? [])],
      aliases: { ...GLOBAL_ALIASES, ...(command.spec?.aliases ?? {}) },
    };
    const args = parseArgs(rest, spec);
    if (has(args, "help")) {
      io.out(commandHelp(command));
      return 0;
    }

    let root: string | undefined;
    let loaded: LoadedSettings | undefined;
    let ws: Workspace | undefined;
    const getRoot = () => (root ??= str(args, "root") ?? findWorkspaceRoot(opts.cwd ?? process.cwd()));
    const getLoaded = () => {
      if (loaded) return loaded;
      const overrides = all(args, "set").map(splitAssignment);
      const rf = str(args, "review-folder");
      if (rf !== undefined) overrides.push(["reviewFolder", rf]);
      const th = str(args, "threshold");
      if (th !== undefined) overrides.push(["matchThreshold", th]);
      return (loaded = loadSettings(getRoot(), overrides, opts.env ?? process.env));
    };
    const ctx: Ctx = {
      args,
      io,
      json: has(args, "json"),
      yes: has(args, "yes"),
      dryRun: has(args, "dry-run"),
      root: getRoot,
      loaded: getLoaded,
      ws: () =>
        (ws ??= new Workspace(
          { root: getRoot(), loaded: getLoaded(), author: str(args, "author"), quiet: has(args, "quiet") },
          io
        )),
    };
    const code = await command.run(ctx);
    if (ws) await ws.store.flush();
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      io.note(`error: ${e.message}`);
      io.note(`usage: eddie ${command.usage.split("\n")[0]}`);
      return 2;
    }
    if (e instanceof CliError) {
      io.note(`error: ${e.message}`);
      return 1;
    }
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT" && err.path) {
      io.note(`error: no such file: ${err.path}`);
      return 1;
    }
    throw e;
  }
}
