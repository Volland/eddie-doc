import * as assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStorage } from "../core/host/memoryStorage.js";
import { COMMANDS_REFERENCE, eddieSkills, installedVersion } from "../core/skills/content.js";
import {
  AGENT_TOOLS,
  detectTools,
  findInstalled,
  installSkills,
  parseTool,
  removeSkills,
  skillTargets,
} from "../core/skills/install.js";
import { COMMANDS } from "../hosts/cli/commands.js";
import { runCli } from "../hosts/cli/run.js";
import type { Io } from "../hosts/cli/workspace.js";

function dirs(tools: Parameters<typeof skillTargets>[0], scope: "project" | "user" = "project"): string[] {
  return skillTargets(tools, scope, "root").map((t) => t.dir);
}

describe("agent skills", () => {
  // @lat: [[tests#Agent skills#Skill files follow the format]]
  describe("skill files", () => {
    const skills = eddieSkills("9.9.9");

    it("have the frontmatter every tool requires, within the format's limits", () => {
      assert.deepStrictEqual(skills.map((s) => s.name), ["eddie-review", "eddie-anchors", "eddie-pipeline"]);
      for (const s of skills) {
        const md = s.files.find((f) => f.path === "SKILL.md")!.content;
        const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)![1];
        assert.match(fm, new RegExp(`^name: ${s.name}$`, "m"));
        assert.match(s.name, /^[a-z0-9-]{1,64}$/);
        const desc = JSON.parse(/^description: (.*)$/m.exec(fm)![1]) as string;
        assert.ok(desc.length > 50 && desc.length <= 1024, `${s.name} description length ${desc.length}`);
        assert.strictEqual(installedVersion(md), "9.9.9");
      }
    });

    it("do not mistake someone else's skill for Eddie's", () => {
      assert.strictEqual(installedVersion("---\nname: eddie-review\ndescription: mine\n---\nbody"), undefined);
      assert.strictEqual(installedVersion("no frontmatter"), undefined);
    });

    it("reference every CLI command and only real ones", () => {
      for (const c of COMMANDS) {
        assert.ok(COMMANDS_REFERENCE.includes(`eddie ${c.name}`), `reference lacks eddie ${c.name}`);
      }
      const named = [...COMMANDS_REFERENCE.matchAll(/`eddie ([a-z-]+)/g)].map((m) => m[1]);
      for (const n of named.filter((x) => x !== "help")) {
        assert.ok(COMMANDS.some((c) => c.name === n || c.aliases?.includes(n)), `reference names unknown command ${n}`);
      }
      for (const s of skills) {
        for (const f of s.files) {
          for (const m of f.content.matchAll(/(?:^\s*|`|&& )eddie ([a-z][a-z-]+)/gm)) {
            const n = m[1];
            if (n === "help") continue;
            assert.ok(COMMANDS.some((c) => c.name === n || c.aliases?.includes(n)), `${s.name}/${f.path} uses unknown command "eddie ${n}"`);
          }
        }
      }
    });
  });

  // @lat: [[tests#Agent skills#Folders per tool]]
  describe("where each tool looks", () => {
    it("uses the fewest folders that reach every chosen tool", () => {
      assert.deepStrictEqual(dirs(["claude"]), ["root/.claude/skills"]);
      assert.deepStrictEqual(dirs(["codex"]), ["root/.agents/skills"]);
      assert.deepStrictEqual(dirs(["cursor", "gemini", "copilot", "other"]), ["root/.agents/skills"]);
      // Cursor and Copilot also read .claude/skills, so one copy serves all three.
      assert.deepStrictEqual(dirs(["claude", "cursor", "copilot"]), ["root/.claude/skills"]);
      assert.deepStrictEqual(dirs(["claude", "codex"]), ["root/.agents/skills", "root/.claude/skills"]);
      assert.deepStrictEqual(dirs(AGENT_TOOLS.map((t) => t.id)), ["root/.agents/skills", "root/.claude/skills"]);
      assert.deepStrictEqual(dirs(["copilot"], "user"), ["root/.agents/skills"]);
    });

    it("reports every chosen tool a folder reaches", () => {
      const [agents, claude] = skillTargets(["claude", "codex", "cursor"], "project", "");
      assert.strictEqual(agents.dir, ".agents/skills");
      assert.deepStrictEqual(agents.tools, ["codex", "cursor"]);
      assert.deepStrictEqual(claude.tools, ["claude", "cursor"]);
    });

    it("parses tool names loosely and detects tools from their files", async () => {
      assert.strictEqual(parseTool("Claude Code"), "claude");
      assert.strictEqual(parseTool("github-copilot"), "copilot");
      assert.strictEqual(parseTool("nope"), undefined);
      const st = new MemoryStorage();
      await st.writeText("proj/CLAUDE.md", "x");
      await st.writeText("proj/.cursor/rules/a.mdc", "x");
      await st.writeText("home/.gemini/settings.json", "{}");
      assert.deepStrictEqual(await detectTools(st, "proj", "home"), ["claude", "cursor", "gemini"]);
      assert.deepStrictEqual(await detectTools(st, "proj"), ["claude", "cursor"]);
    });
  });

  // @lat: [[tests#Agent skills#Installing safely]]
  describe("installing", () => {
    it("installs, recognises an up-to-date copy, and updates an old one", async () => {
      const st = new MemoryStorage();
      const targets = skillTargets(["claude", "codex"], "project", "p");
      const first = await installSkills(st, targets, eddieSkills("1.0.0"));
      assert.ok(first.every((o) => o.status === "installed"));
      assert.strictEqual(first.length, 6);
      assert.ok(await st.exists("p/.claude/skills/eddie-review/references/commands.md"));
      const again = await installSkills(st, targets, eddieSkills("1.0.0"));
      assert.ok(again.every((o) => o.status === "unchanged"));
      const upd = await installSkills(st, targets, eddieSkills("2.0.0"));
      assert.ok(upd.every((o) => o.status === "updated"));
      const found = await findInstalled(st, eddieSkills("2.0.0"), { project: "p" });
      assert.strictEqual(found.length, 6);
      assert.ok(found.every((f) => f.version === "2.0.0"));
    });

    it("leaves a user's own skill of the same name alone unless forced, and never removes it", async () => {
      const st = new MemoryStorage();
      await st.writeText("p/.claude/skills/eddie-review/SKILL.md", "---\nname: eddie-review\ndescription: mine\n---\n");
      const targets = skillTargets(["claude"], "project", "p");
      const out = await installSkills(st, targets, eddieSkills("1.0.0"));
      assert.strictEqual(out.find((o) => o.skill === "eddie-review")!.status, "skipped");
      assert.match(await st.readText("p/.claude/skills/eddie-review/SKILL.md"), /description: mine/);
      const rm = await removeSkills(st, targets, eddieSkills("1.0.0"));
      assert.deepStrictEqual(rm.skipped, ["p/.claude/skills/eddie-review"]);
      assert.ok(await st.exists("p/.claude/skills/eddie-review/SKILL.md"));
      assert.ok(!(await st.exists("p/.claude/skills/eddie-anchors/SKILL.md")));
      const forced = await installSkills(st, targets, eddieSkills("1.0.0"), { force: true });
      assert.strictEqual(forced.find((o) => o.skill === "eddie-review")!.status, "updated");
    });

    it("writes nothing on a dry run", async () => {
      const st = new MemoryStorage();
      const out = await installSkills(st, skillTargets(["claude"], "project", "p"), eddieSkills("1.0.0"), { dryRun: true });
      assert.ok(out.every((o) => o.status === "installed"));
      assert.ok(!(await st.exists("p/.claude/skills/eddie-review/SKILL.md")));
    });
  });

  // @lat: [[tests#Agent skills#Asking which tools from the CLI]]
  describe("eddie skills", () => {
    let root: string;
    let home: string;
    const io = (answers: string[] = [], interactive = false) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const value: Io = {
        out: (l = "") => void stdout.push(l),
        note: (l = "") => void stderr.push(l),
        ask: async () => answers.shift() ?? "",
        interactive,
        readStdin: async () => "",
      };
      return { value, stdout, stderr };
    };
    const run = (argv: string[], cap = io()) =>
      runCli([...argv, "--root", root, "--home", home], cap.value, { env: {} }).then((code) => ({ code, ...cap }));

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), "eddie-skills-"));
      home = mkdtempSync(path.join(os.tmpdir(), "eddie-home-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it("asks which tools and where on a terminal, preselecting what it finds", async () => {
      mkdirSync(path.join(root, ".cursor"));
      const cap = io(["", "u"], true); // accept the detected default (Cursor), then user scope
      const r = await run(["skills"], cap);
      assert.strictEqual(r.code, 0, r.stderr.join("\n"));
      assert.match(r.stderr.join("\n"), /Which AI coding tools do you use\?/);
      assert.match(r.stderr.join("\n"), /Cursor\s+\(found here\)/);
      assert.ok(existsSync(path.join(home, ".agents/skills/eddie-review/SKILL.md")));
      assert.ok(!existsSync(path.join(root, ".agents")));
    });

    it("takes the tools as numbers, and re-asks on a bad answer", async () => {
      const cap = io(["9", "1,2", "p"], true);
      const r = await run(["skills", "install"], cap);
      assert.strictEqual(r.code, 0);
      assert.match(r.stderr.join("\n"), /answer with numbers/);
      assert.ok(existsSync(path.join(root, ".claude/skills/eddie-anchors/SKILL.md")));
      assert.ok(existsSync(path.join(root, ".agents/skills/eddie-anchors/SKILL.md")));
    });

    it("installs from flags in a script, lists, and removes only with --yes", async () => {
      assert.strictEqual((await run(["skills", "install"])).code, 2, "no tools found and none given");
      assert.strictEqual((await run(["skills", "install", "--tool", "claude"])).code, 0);
      const listed = JSON.parse((await run(["skills", "list", "--json"])).stdout.join("\n"));
      assert.strictEqual(listed.installed.length, 3);
      assert.strictEqual((await run(["skills", "remove"])).code, 1, "asks first without a terminal");
      assert.strictEqual((await run(["skills", "remove", "--yes"])).code, 0);
      assert.ok(!existsSync(path.join(root, ".claude/skills/eddie-review")), "empty folder tidied");
      assert.ok(existsSync(path.join(root, ".claude/skills")), "the tool's own folder stays");
    });

    it("refuses to overwrite a user's skill without --force", async () => {
      mkdirSync(path.join(root, ".claude/skills/eddie-review"), { recursive: true });
      writeFileSync(path.join(root, ".claude/skills/eddie-review/SKILL.md"), "---\nname: eddie-review\ndescription: mine\n---\n");
      const r = await run(["skills", "install", "--tool", "claude"]);
      assert.strictEqual(r.code, 1);
      assert.match(readFileSync(path.join(root, ".claude/skills/eddie-review/SKILL.md"), "utf8"), /mine/);
      assert.strictEqual((await run(["skills", "install", "--tool", "claude", "--force"])).code, 0);
    });

    it("prints a skill", async () => {
      const r = await run(["skills", "show", "eddie-anchors"]);
      assert.match(r.stdout.join("\n"), /^name: eddie-anchors$/m);
    });
  });
});
