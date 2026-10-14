import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { NodeStorage } from "../node/nodeStorage.js";
import { PRODUCER } from "../../core/model/format.js";
import { eddieSkills } from "../../core/skills/content.js";
import {
  AGENT_TOOLS,
  detectTools,
  installSkills,
  skillTargets,
  type AgentTool,
  type SkillScope,
} from "../../core/skills/install.js";

/**
 * `Eddie Doc: Install Agent Skills…` — ask which AI coding tools the author
 * uses, and where (this workspace or every project), then write Eddie Doc's
 * Agent Skills into the folders those tools read. The same installer the
 * `eddie skills` CLI command and the Obsidian plugin use.
 */
export async function installAgentSkills(): Promise<void> {
  const storage = new NodeStorage();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const home = os.homedir();
  const detected = await detectTools(storage, root ?? home, home);

  interface ToolPick extends vscode.QuickPickItem {
    id: AgentTool;
  }
  const picks: ToolPick[] = AGENT_TOOLS.map((t) => ({
    id: t.id,
    label: t.label,
    description: detected.includes(t.id) ? "found here" : undefined,
    picked: detected.length ? detected.includes(t.id) : t.id === "claude",
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    title: "Which AI coding tools do you use?",
    placeHolder: "Eddie's skills (eddie-review, eddie-anchors, eddie-pipeline) go where each tool looks",
  });
  if (!chosen?.length) return;
  const tools = chosen.map((c) => c.id);

  interface ScopePick extends vscode.QuickPickItem {
    scope: SkillScope;
  }
  const scopes: ScopePick[] = [];
  if (root) {
    scopes.push({
      scope: "project",
      label: "This workspace",
      description: root,
      detail: "Commit the skill folders so everyone on the project gets them.",
    });
  }
  scopes.push({
    scope: "user",
    label: "My user account",
    description: home,
    detail: "Available in every project on this machine.",
  });
  const where = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { title: "Install the skills for…" });
  if (!where) return;

  const base = where.scope === "project" ? root! : home;
  const targets = skillTargets(tools, where.scope, base);
  try {
    const out = await installSkills(storage, targets, eddieSkills(PRODUCER.version));
    const skipped = out.filter((o) => o.status === "skipped");
    const changed = out.filter((o) => o.status === "installed" || o.status === "updated").length;
    const dirs = targets.map((t) => path.relative(base, t.dir) || t.dir).join(", ");
    const msg =
      `Eddie Doc: ${changed ? `installed ${changed} skill file set(s)` : "skills already up to date"} in ` +
      `${where.scope === "user" ? "~/" : ""}${dirs}.` +
      (skipped.length ? ` Skipped ${skipped.length}: a skill with that name exists that Eddie Doc did not write.` : "");
    const action = await (skipped.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(
      msg,
      "Open Skill Folder"
    );
    if (action) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(targets[0].dir, "eddie-review", "SKILL.md")));
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Eddie Doc: could not install the skills — ${String(e)}`);
  }
}
