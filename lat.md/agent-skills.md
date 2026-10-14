# Agent skills

Eddie Doc ships Agent Skills that teach AI coding tools to use it: working through a review with `eddie`, keeping `// eddie:` anchors intact, and running the round-trip.

## The skills

Three skills in the open Agent Skills format (`<name>/SKILL.md` with `name` and `description` frontmatter), defined as strings in [[src/core/skills/content.ts#eddieSkills]].

`eddie-review` covers the remark loop (list, show, edit, reply, resolve, fix, apply, triage) and carries `references/commands.md`, a one-line-per-command reference. `eddie-anchors` holds the marker rules from `docs/MANUSCRIPT-CLAUDE.md`. `eddie-pipeline` covers mapping PDFs, rounds, reports, stamping and CI. Strings rather than files, so every Host, Obsidian on mobile included, installs them without a bundle directory. A test holds every `eddie <command>` the skills mention to the CLI's real command list.

## Where each tool looks

Each tool reads skills from its own folders; [[src/core/skills/install.ts#AGENT_TOOLS]] records them as each vendor documents them.

Claude Code reads `.claude/skills`. Codex reads `.agents/skills`; Gemini CLI `.agents/` or `.gemini/skills`; Cursor `.agents/`, `.cursor/`, `.claude/` and `.codex/skills`; Copilot `.agents/`, `.github/` and `.claude/skills` (user-wide `.copilot/skills`). The same names apply under the home folder for a user-wide install. [[src/core/skills/install.ts#skillTargets]] picks the fewest folders reaching every chosen tool, shared folders first: Claude Code with Cursor is one copy in `.claude/skills`, Claude Code with Codex needs two.

## Installing safely

[[src/core/skills/install.ts#installSkills]] writes through the Storage port and never replaces a skill it did not write.

Ownership is the `metadata.generator: eddie-doc` frontmatter key, which also records the version, so an install reports installed, updated, unchanged or skipped. A same-named skill without it is left alone unless forced, and [[src/core/skills/install.ts#removeSkills]] removes only Eddie's own files. [[src/core/skills/install.ts#detectTools]] looks for each tool's files (`CLAUDE.md`, `.cursor`, `.gemini`…) so the question "which tools do you use?" starts with the right answers.

## Entry points

Every Host asks which tools are in use, preselecting the detected ones, and installs with the same core code.

The CLI's `eddie skills` ([[src/hosts/cli/skills.ts#skillsCommand]]) asks on a terminal for tools and for project or user scope, takes `--tool`/`--scope` in scripts, and has `list`, `remove` and `show`. The TUI's `S` key opens a checklist, then the scope. VS Code's *Install Agent Skills for AI Tools…* ([[src/hosts/vscode/skills.ts#installAgentSkills]]) uses a multi-select quick pick. The Obsidian command installs into the vault only, because a plugin cannot reach the home folder on mobile.
