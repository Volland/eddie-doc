/**
 * Installing Eddie Doc's Agent Skills where each AI coding tool looks for them.
 *
 * Every tool reads `<dir>/<skill>/SKILL.md`, but from different folders. These
 * are the folders each one documents (checked October 2026):
 *
 * | Tool           | Project                                        | User (~)                                       |
 * | -------------- | ---------------------------------------------- | ---------------------------------------------- |
 * | Claude Code    | .claude/skills                                 | .claude/skills                                 |
 * | Codex          | .agents/skills                                 | .agents/skills                                 |
 * | Cursor         | .agents/, .cursor/, .claude/, .codex/ skills   | .agents/, .cursor/, .claude/, .codex/ skills   |
 * | Gemini CLI     | .agents/skills, .gemini/skills                 | .agents/skills, .gemini/skills                 |
 * | GitHub Copilot | .agents/, .github/, .claude/ skills            | .agents/skills, .copilot/skills                |
 * | Other          | .agents/skills (the shared Agent Skills folder) | .agents/skills                                |
 *
 * {@link skillTargets} picks the fewest folders that reach every chosen tool,
 * so Claude Code + Cursor is one copy in `.claude/skills`, and a tool reading
 * two copies of the same skill is avoided where possible.
 *
 * All file access goes through {@link Storage}, so the CLI, VS Code and an
 * Obsidian vault install the same way. A skill folder is only replaced or
 * removed when its `SKILL.md` says Eddie Doc wrote it.
 */
import * as path from "../util/path.js";
import type { Storage } from "../host/storage.js";
import { installedVersion, type Skill } from "./content.js";

export type AgentTool = "claude" | "codex" | "cursor" | "gemini" | "copilot" | "other";
export type SkillScope = "project" | "user";

export interface ToolInfo {
  id: AgentTool;
  label: string;
  /** Folders the tool reads skills from, relative to the project root. */
  project: string[];
  /** Folders it reads in the user's home. */
  user: string[];
  /** Files or folders whose presence suggests the tool is in use. */
  detectProject: string[];
  detectUser: string[];
}

export const AGENT_TOOLS: ToolInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    project: [".claude/skills"],
    user: [".claude/skills"],
    detectProject: [".claude", "CLAUDE.md"],
    detectUser: [".claude"],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    project: [".agents/skills"],
    user: [".agents/skills"],
    detectProject: ["AGENTS.md", ".codex"],
    detectUser: [".codex"],
  },
  {
    id: "cursor",
    label: "Cursor",
    project: [".agents/skills", ".cursor/skills", ".claude/skills", ".codex/skills"],
    user: [".agents/skills", ".cursor/skills", ".claude/skills", ".codex/skills"],
    detectProject: [".cursor", ".cursorrules"],
    detectUser: [".cursor"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    project: [".agents/skills", ".gemini/skills"],
    user: [".agents/skills", ".gemini/skills"],
    detectProject: [".gemini", "GEMINI.md"],
    detectUser: [".gemini"],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    project: [".agents/skills", ".github/skills", ".claude/skills"],
    user: [".agents/skills", ".copilot/skills"],
    detectProject: [".github/copilot-instructions.md", ".github/skills"],
    detectUser: [".copilot"],
  },
  {
    id: "other",
    label: "Other (any tool that reads .agents/skills: OpenCode, Amp, Kiro…)",
    project: [".agents/skills"],
    user: [".agents/skills"],
    detectProject: [],
    detectUser: [],
  },
];

/** Shared folders first: one copy there serves the most tools. */
const PREFERENCE = [".agents/skills", ".claude/skills"];

export function toolInfo(id: AgentTool): ToolInfo {
  const t = AGENT_TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown tool ${id}`);
  return t;
}

/** `claude`, `Claude Code`, `claude-code` → `claude`. */
export function parseTool(name: string): AgentTool | undefined {
  const n = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Record<string, AgentTool> = {
    claude: "claude",
    claudecode: "claude",
    codex: "codex",
    openai: "codex",
    openaicodex: "codex",
    cursor: "cursor",
    gemini: "gemini",
    geminicli: "gemini",
    copilot: "copilot",
    githubcopilot: "copilot",
    vscode: "copilot",
    other: "other",
    agents: "other",
    opencode: "other",
    amp: "other",
    kiro: "other",
  };
  return aliases[n];
}

export interface SkillTarget {
  /** The skills folder, joined onto the base (project root or home). */
  dir: string;
  /** The chosen tools that read this folder. */
  tools: AgentTool[];
}

/**
 * The fewest folders under `base` that every tool in `tools` reads, each with
 * the tools it serves. A greedy cover: at each step the folder reaching the
 * most still-uncovered tools wins, shared folders first on a tie.
 */
export function skillTargets(tools: AgentTool[], scope: SkillScope, base: string): SkillTarget[] {
  const want = [...new Set(tools)];
  const dirsOf = (t: AgentTool) => toolInfo(t)[scope];
  const out: SkillTarget[] = [];
  let left = [...want];
  while (left.length) {
    const candidates = [...new Set(left.flatMap(dirsOf))];
    const rank = (d: string) => {
      const p = PREFERENCE.indexOf(d);
      return p < 0 ? PREFERENCE.length : p;
    };
    candidates.sort(
      (a, b) =>
        left.filter((t) => dirsOf(t).includes(b)).length - left.filter((t) => dirsOf(t).includes(a)).length ||
        rank(a) - rank(b)
    );
    const dir = candidates[0];
    out.push({ dir, tools: [] });
    left = left.filter((t) => !dirsOf(t).includes(dir));
  }
  // Report every chosen tool a folder reaches, not only the ones it was picked for.
  for (const t of out) t.tools = want.filter((w) => dirsOf(w).includes(t.dir));
  return out.map((t) => ({ ...t, dir: path.join(base, t.dir) }));
}

/** Tools that look in use under `root` (and `home`, when the host has one). */
export async function detectTools(storage: Storage, root: string, home?: string): Promise<AgentTool[]> {
  const found: AgentTool[] = [];
  for (const t of AGENT_TOOLS) {
    let hit = false;
    for (const f of t.detectProject) if (!hit && (await storage.exists(path.join(root, f)))) hit = true;
    if (home) for (const f of t.detectUser) if (!hit && (await storage.exists(path.join(home, f)))) hit = true;
    if (hit) found.push(t.id);
  }
  return found;
}

export type InstallStatus = "installed" | "updated" | "unchanged" | "skipped";

export interface InstallOutcome {
  dir: string;
  skill: string;
  status: InstallStatus;
  /** Why a skill was skipped. */
  reason?: string;
}

async function readIfExists(storage: Storage, file: string): Promise<string | undefined> {
  if (!(await storage.exists(file))) return undefined;
  try {
    return await storage.readText(file);
  } catch {
    return undefined;
  }
}

/**
 * Write each skill into each target folder. A folder holding a `SKILL.md` that
 * Eddie Doc did not write is someone else's skill and is left alone unless
 * `force`. With `dryRun`, nothing is written and the outcome says what would be.
 */
export async function installSkills(
  storage: Storage,
  targets: SkillTarget[],
  skills: Skill[],
  opts: { force?: boolean; dryRun?: boolean } = {}
): Promise<InstallOutcome[]> {
  const out: InstallOutcome[] = [];
  for (const t of targets) {
    for (const s of skills) {
      const folder = path.join(t.dir, s.name);
      const existing = await readIfExists(storage, path.join(folder, "SKILL.md"));
      if (existing !== undefined && installedVersion(existing) === undefined && !opts.force) {
        out.push({ dir: t.dir, skill: s.name, status: "skipped", reason: "a skill with this name exists that Eddie Doc did not write (use force to replace it)" });
        continue;
      }
      let same = existing !== undefined;
      if (same) {
        for (const f of s.files) {
          if ((await readIfExists(storage, path.join(folder, f.path))) !== f.content) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        out.push({ dir: t.dir, skill: s.name, status: "unchanged" });
        continue;
      }
      if (!opts.dryRun) {
        for (const f of s.files) await storage.writeText(path.join(folder, f.path), f.content);
      }
      out.push({ dir: t.dir, skill: s.name, status: existing === undefined ? "installed" : "updated" });
    }
  }
  return out;
}

/**
 * Remove Eddie Doc's skills from each target folder: only folders whose
 * `SKILL.md` Eddie Doc wrote, and only the files it writes. Returns the files
 * removed; the now-empty folders are left for the host to tidy.
 */
export async function removeSkills(
  storage: Storage,
  targets: SkillTarget[],
  skills: Skill[],
  opts: { dryRun?: boolean } = {}
): Promise<{ removed: string[]; skipped: string[] }> {
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    for (const s of skills) {
      const folder = path.join(t.dir, s.name);
      const md = await readIfExists(storage, path.join(folder, "SKILL.md"));
      if (md === undefined) continue;
      if (installedVersion(md) === undefined) {
        skipped.push(folder);
        continue;
      }
      for (const f of s.files) {
        const file = path.join(folder, f.path);
        if (!(await storage.exists(file))) continue;
        if (!opts.dryRun) await storage.remove(file);
        removed.push(file);
      }
    }
  }
  return { removed, skipped };
}

export interface SkillPresence {
  dir: string;
  scope: SkillScope;
  /** Tools that read this folder. */
  tools: AgentTool[];
  skill: string;
  /** Eddie Doc's version that wrote it, `"foreign"` for someone else's skill. */
  version: string;
}

/** Every Eddie Doc skill already present in any folder any tool reads. */
export async function findInstalled(
  storage: Storage,
  skills: Skill[],
  bases: { project: string; user?: string }
): Promise<SkillPresence[]> {
  const out: SkillPresence[] = [];
  for (const scope of ["project", "user"] as const) {
    const base = scope === "project" ? bases.project : bases.user;
    if (base === undefined) continue;
    const dirs = [...new Set(AGENT_TOOLS.flatMap((t) => t[scope]))];
    for (const rel of dirs) {
      const dir = path.join(base, rel);
      for (const s of skills) {
        const md = await readIfExists(storage, path.join(dir, s.name, "SKILL.md"));
        if (md === undefined) continue;
        out.push({
          dir,
          scope,
          tools: AGENT_TOOLS.filter((t) => t[scope].includes(rel)).map((t) => t.id),
          skill: s.name,
          version: installedVersion(md) ?? "foreign",
        });
      }
    }
  }
  return out;
}
