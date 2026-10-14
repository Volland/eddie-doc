/**
 * `eddie skills`: install the Agent Skills that teach AI coding tools how to
 * use Eddie Doc, into the folders each tool reads.
 *
 *   eddie skills                      ask which tools you use, then install
 *   eddie skills install --tool claude,cursor [--scope user]
 *   eddie skills list                 what is installed where, and its version
 *   eddie skills remove [--tool …]    take Eddie Doc's skills out again
 *   eddie skills show eddie-review    print a skill
 */
import * as os from "node:os";
import * as path from "node:path";
import { has, list, str, UsageError } from "./args.js";
import { CliError } from "./workspace.js";
import { tidySkillFolders } from "./actions.js";
import type { Command, Ctx } from "./commands.js";
import { PRODUCER } from "../../core/model/format.js";
import { eddieSkills } from "../../core/skills/content.js";
import {
  AGENT_TOOLS,
  detectTools,
  findInstalled,
  installSkills,
  parseTool,
  removeSkills,
  skillTargets,
  toolInfo,
  type AgentTool,
  type InstallOutcome,
  type SkillScope,
} from "../../core/skills/install.js";
import { NodeStorage } from "../node/nodeStorage.js";

const storage = new NodeStorage();

function home(ctx: Ctx): string {
  return path.resolve(str(ctx.args, "home") ?? os.homedir());
}

function scopeOf(ctx: Ctx): SkillScope | undefined {
  if (has(ctx.args, "user")) return "user";
  if (has(ctx.args, "project")) return "project";
  const s = str(ctx.args, "scope");
  if (s === undefined) return undefined;
  if (s !== "project" && s !== "user") throw new UsageError("--scope must be project or user");
  return s;
}

function toolsOf(ctx: Ctx): AgentTool[] | undefined {
  if (has(ctx.args, "all")) return AGENT_TOOLS.map((t) => t.id);
  const names = list(ctx.args, "tool");
  if (!names.length) return undefined;
  return names.map((n) => {
    const t = parseTool(n);
    if (!t) throw new UsageError(`unknown tool "${n}" — one of: ${AGENT_TOOLS.map((x) => x.id).join(", ")}`);
    return t;
  });
}

/** Ask on the terminal which tools are in use; detected ones are the default. */
async function askTools(ctx: Ctx, detected: AgentTool[]): Promise<AgentTool[]> {
  ctx.io.note("Which AI coding tools do you use? Eddie's skills will be installed where each one looks.");
  AGENT_TOOLS.forEach((t, i) =>
    ctx.io.note(`  ${i + 1}) ${t.label}${detected.includes(t.id) ? "   (found here)" : ""}`)
  );
  const def = detected.length ? detected.map((d) => AGENT_TOOLS.findIndex((t) => t.id === d) + 1).join(",") : "1";
  for (;;) {
    const a = (await ctx.io.ask(`Numbers separated by commas, or "a" for all [${def}]: `)) || def;
    if (/^a(ll)?$/i.test(a)) return AGENT_TOOLS.map((t) => t.id);
    const picks = a.split(/[\s,]+/).filter(Boolean).map(Number);
    if (picks.length && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= AGENT_TOOLS.length)) {
      return [...new Set(picks.map((n) => AGENT_TOOLS[n - 1].id))];
    }
    ctx.io.note("  ? answer with numbers from the list, e.g. 1,3");
  }
}

async function askScope(ctx: Ctx, root: string, homeDir: string): Promise<SkillScope> {
  ctx.io.note("Install for:");
  ctx.io.note(`  p) this project — ${root}   (commit them so collaborators get them)`);
  ctx.io.note(`  u) your user account — ${homeDir}   (every project on this machine)`);
  for (;;) {
    const a = ((await ctx.io.ask("p or u [p]: ")) || "p").toLowerCase();
    if (a === "p" || a === "project") return "project";
    if (a === "u" || a === "user") return "user";
  }
}

function describe(outcomes: InstallOutcome[], show: (p: string) => string): string[] {
  const lines: string[] = [];
  for (const dir of [...new Set(outcomes.map((o) => o.dir))]) {
    const here = outcomes.filter((o) => o.dir === dir);
    lines.push(`${show(dir)}`);
    for (const o of here) lines.push(`  ${o.status.padEnd(9)} ${o.skill}${o.reason ? ` — ${o.reason}` : ""}`);
  }
  return lines;
}

export const skillsCommand: Command = {
  name: "skills",
  group: "Workspace",
  summary: "Install the agent skills that teach Claude Code, Codex, Cursor… to use eddie",
  usage:
    "skills [install] [--tool claude,codex,cursor,gemini,copilot,other | --all] [--scope project|user]\n" +
    "       [--force] [--dry-run]\n" +
    "skills list [--json]\n" +
    "skills remove [--tool …] [--scope project|user] [--yes]\n" +
    "skills show <eddie-review|eddie-anchors|eddie-pipeline>",
  details:
    "Three skills: eddie-review (work through an editor's remarks), eddie-anchors (keep\n" +
    "// eddie: markers intact when editing .adoc) and eddie-pipeline (map PDFs, rounds,\n" +
    "reports, stamping, CI). Without --tool, a terminal is asked which tools you use, with\n" +
    "the ones found in the project preselected; in a script the detected tools are used.\n" +
    "Each tool's folder: Claude Code .claude/skills; Codex, Gemini CLI, Cursor, Copilot and\n" +
    "others share .agents/skills. The fewest folders that reach every chosen tool are used.\n" +
    "Project scope writes under the workspace root, user scope under your home (--home).\n" +
    "A skill folder Eddie Doc did not write is never replaced (unless --force) or removed.",
  spec: { values: ["tool", "scope", "home"] },
  async run(ctx) {
    const [sub = "install", arg] = ctx.args.positional;
    const version = PRODUCER.version;
    const skills = eddieSkills(version);
    const root = ctx.root();
    const homeDir = home(ctx);
    const show = (p: string) => {
      const r = path.relative(process.cwd(), p);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) return r;
      const h = path.relative(homeDir, p);
      return h && !h.startsWith("..") && !path.isAbsolute(h) ? `~/${h}` : p;
    };

    if (sub === "show") {
      const s = skills.find((x) => x.name === arg);
      if (!s) throw new UsageError(`skills show needs one of: ${skills.map((x) => x.name).join(", ")}`);
      ctx.io.out(s.files[0].content);
      return 0;
    }

    if (sub === "list") {
      const found = await findInstalled(storage, skills, { project: root, user: homeDir });
      if (ctx.json) {
        ctx.io.out(JSON.stringify({ version, skills: skills.map((s) => ({ name: s.name, summary: s.summary })), installed: found }, null, 2));
        return 0;
      }
      ctx.io.out(`Eddie Doc ${version} ships:`);
      for (const s of skills) ctx.io.out(`  ${s.name.padEnd(16)} ${s.summary}`);
      ctx.io.out("");
      if (!found.length) {
        ctx.io.out("Not installed anywhere yet — run: eddie skills");
        return 0;
      }
      for (const dir of [...new Set(found.map((f) => f.dir))]) {
        const here = found.filter((f) => f.dir === dir);
        const tools = here[0].tools.map((t) => toolInfo(t).label.replace(/ \(.*/, "")).join(", ");
        ctx.io.out(`${show(dir)}  (${here[0].scope}; read by ${tools})`);
        for (const f of here) {
          const state = f.version === "foreign" ? "not Eddie's — left alone" : f.version === version ? `v${f.version}` : `v${f.version}, outdated — run: eddie skills`;
          ctx.io.out(`  ${f.skill.padEnd(16)} ${state}`);
        }
      }
      return 0;
    }

    if (sub === "remove" || sub === "uninstall") {
      const tools = toolsOf(ctx);
      const scope = scopeOf(ctx);
      let targets;
      if (tools) {
        targets = (scope ? [scope] : (["project", "user"] as const)).flatMap((sc) =>
          skillTargets(tools, sc, sc === "project" ? root : homeDir)
        );
      } else {
        const found = (await findInstalled(storage, skills, { project: root, user: homeDir })).filter(
          (f) => f.version !== "foreign" && (!scope || f.scope === scope)
        );
        targets = [...new Set(found.map((f) => f.dir))].map((dir) => ({ dir, tools: [] }));
      }
      const plan = await removeSkills(storage, targets, skills, { dryRun: true });
      if (!plan.removed.length) {
        ctx.io.out("no Eddie Doc skills to remove");
        return 0;
      }
      for (const f of plan.removed) ctx.io.note(`  ${show(f)}`);
      if (ctx.dryRun) {
        ctx.io.out(`would remove ${plan.removed.length} file(s)`);
        return 0;
      }
      if (!ctx.yes) {
        if (!ctx.io.interactive) throw new CliError("remove asks first — pass --yes in a script");
        if (!/^y(es)?$/i.test(await ctx.io.ask(`Remove ${plan.removed.length} file(s)? [y/N] `))) return 1;
      }
      const res = await removeSkills(storage, targets, skills);
      tidySkillFolders(res.removed);
      ctx.io.out(`removed ${res.removed.length} file(s)`);
      return 0;
    }

    if (sub !== "install") throw new UsageError(`unknown subcommand "${sub}" — install, list, remove or show`);

    const detected = await detectTools(storage, root, homeDir);
    let tools = toolsOf(ctx);
    let scope = scopeOf(ctx);
    if (!tools) {
      if (ctx.io.interactive && !ctx.json) tools = await askTools(ctx, detected);
      else if (detected.length) {
        tools = detected;
        ctx.io.note(`no --tool given; using the tools found here: ${detected.join(", ")}`);
      } else {
        throw new UsageError(`which tools? pass --tool ${AGENT_TOOLS.map((t) => t.id).join(",")} (or --all)`);
      }
    }
    if (!scope) scope = ctx.io.interactive && !ctx.json && !toolsOf(ctx) ? await askScope(ctx, root, homeDir) : "project";

    const targets = skillTargets(tools, scope, scope === "project" ? root : homeDir);
    const outcomes = await installSkills(storage, targets, skills, { force: has(ctx.args, "force"), dryRun: ctx.dryRun });
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ version, scope, tools, targets, outcomes }, null, 2));
    } else {
      for (const l of describe(outcomes, show)) ctx.io.out(ctx.dryRun ? `(dry run) ${l}` : l);
      for (const t of targets) {
        ctx.io.note(`  ${show(t.dir)} is read by ${t.tools.map((x) => toolInfo(x).label.replace(/ \(.*/, "")).join(", ")}`);
      }
      if (scope === "project" && !ctx.dryRun) ctx.io.note("Commit these folders so everyone on the project gets the skills.");
    }
    return outcomes.some((o) => o.status === "skipped") ? 1 : 0;
  },
};
