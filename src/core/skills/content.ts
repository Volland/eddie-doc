/**
 * The Agent Skills Eddie Doc installs for AI coding agents.
 *
 * Each skill is a folder with a `SKILL.md` (YAML frontmatter + instructions) in
 * the open Agent Skills format, which Claude Code, Codex, Cursor, Gemini CLI,
 * GitHub Copilot and others load. The texts live here, as strings, so every
 * Host can install them without reading files — Obsidian on mobile has no
 * bundle directory to read from.
 *
 * `version` is stamped into each skill's metadata; it is how an installer
 * recognises its own files (to update or remove them) and leaves a user's
 * skill of the same name alone.
 */

export interface SkillFile {
  /** Path inside the skill folder, `/`-separated. */
  path: string;
  content: string;
}

export interface Skill {
  /** Folder name and frontmatter `name`. */
  name: string;
  /** One line for menus. */
  summary: string;
  files: SkillFile[];
}

/** The frontmatter key that marks a skill as installed by Eddie Doc. */
export const GENERATOR = "eddie-doc";

function frontmatter(name: string, description: string, version: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "license: MIT",
    "metadata:",
    `  generator: ${GENERATOR}`,
    `  version: "${version}"`,
    "---",
    "",
  ].join("\n");
}

const REVIEW_DESCRIPTION =
  "Work through an editor's PDF review of an AsciiDoc manuscript with the `eddie` CLI (Eddie Doc): " +
  "list open remarks, read each in its source context, edit the .adoc, reply, resolve, apply suggested " +
  "edits and place unmatched marks. Use when the user mentions editor or copyeditor comments, review " +
  "remarks, an annotated PDF, `.eddie/` folders or `*.review.json` files, or asks to address, answer or " +
  "resolve review feedback on .adoc files. Do not use for writing new content unrelated to a review.";

const ANCHORS_DESCRIPTION =
  "Rules for editing AsciiDoc (.adoc) files that contain `// eddie:<id>` comment lines placed by Eddie Doc. " +
  "Use whenever editing, rewriting, reflowing, splitting, reordering or reformatting a .adoc file that " +
  "contains `// eddie:` lines, so review marks stay attached to the right paragraphs.";

const PIPELINE_DESCRIPTION =
  "Run Eddie Doc's review round-trip from scripts or the terminal: map a newly returned annotated PDF " +
  "(new round or second reviewer), inspect rounds and mappings, export Markdown review reports, stamp " +
  "replies into a fresh asciidoctor-pdf render, and gate CI on open remarks. Use when the user asks to " +
  "import an editor's PDF, start a review round, send a review back, stamp or build reviewed PDFs, or " +
  "automate Eddie Doc in a build.";

function reviewSkill(version: string): Skill {
  const body = `# Working through an editorial review with \`eddie\`

An editor marked up a PDF rendered from the user's AsciiDoc source. Eddie Doc
mapped every mark (highlight, strikeout, comment, insert) onto the source line it
refers to. Your job is to work through those remarks: change the prose where the
editor is right, answer where a decision needs explaining, and record what was
done so the editor sees it.

## Before you start

1. Check the CLI: \`eddie version\`. If it is missing, use \`npx @eddie-doc/cli\` in
   place of \`eddie\` in every command below, or ask the user to install it
   (\`npm install -g @eddie-doc/cli\`, or from VS Code: *Eddie Doc: Install 'eddie'
   Command in PATH*).
2. Find what is under review: \`eddie status\` (every reviewed document) or
   \`eddie rounds <file.adoc>\` (one document's rounds and mappings).
3. If the editor's PDF has not been mapped yet, see the \`eddie-pipeline\` skill
   (\`eddie open <file.adoc> <annotated.pdf>\`).

Always pass \`--json\` when you read output, and work on one document at a time.

## The loop

\`\`\`bash
# What still needs a decision, in reading order. Each item has a stable "number".
eddie list ch04.adoc --bucket open,review --json

# One remark in full: the editor's comment, the marked words, the source lines
# it points at ("line"/"endLine", 1-based), and any replies so far.
eddie show ch04.adoc 7 --json
\`\`\`

For each remark:

1. **Read it in context.** \`show\` gives the line range; read those lines of the
   .adoc (and a little around them) before deciding.
2. **Decide.**
   - *Agree:* edit the .adoc. Keep every \`// eddie:\` line exactly as it is (see
     the \`eddie-anchors\` skill). Then reply with what you changed and resolve:
     \`eddie reply ch04.adoc 7 "Reworded to 'trust or lineage'."\`
     \`eddie resolve ch04.adoc 7\`
   - *Mechanical edit the editor spelled out* (delete struck words, replace with
     quoted text, insert at a caret): \`eddie fix ch04.adoc 7\` lists the actions,
     \`eddie fix ch04.adoc 7 delete-struck --dry-run\` previews,
     then run it without \`--dry-run\`. It resolves the remark itself.
   - *Disagree or unsure:* do not change the text. Reply with your reasoning and
     leave it open for the author:
     \`eddie reply ch04.adoc 7 "Kept: the term is defined in chapter 2."\`
   - *Needs the author* (a factual claim, a figure, a structural change): reply
     with a question or a proposal, leave it open, and tell the user.
3. Move on. Re-run \`list\` now and then; numbers never change.

### Many mechanical edits at once

\`eddie apply ch04.adoc --dry-run\` prints every confident deletion, replacement
and insertion. Show the plan to the user; run \`eddie apply ch04.adoc --yes\` only
after they agree. It edits the source and resolves those remarks.

### Remarks without a place ("unmatched") or with a doubtful one ("review")

- \`eddie triage ch04.adoc --json\` lists ranked candidate lines for each unmatched
  remark. If one clearly fits, link it: \`eddie relink ch04.adoc 12 48\` (line 48).
- A \`review\` remark is placed but uncertain, or *stale* (its text changed). Read
  the line; if the placement is right, \`eddie confirm ch04.adoc 9\`; if not,
  \`relink\` it.
- Never guess. If no line fits, leave it and say so.

### After editing the source outside a remark

\`eddie remap ch04.adoc\` re-matches every round against the current text.

## Rules

- **Never resolve a remark you did not address.** Resolving means "done"; the
  editor will read it that way.
- **Reply when you decline, when you change something other than what was
  asked, or when the fix is not obvious.** Replies are written into the PDF that
  goes back to the editor; keep them short, factual and polite.
- **Do not hand-edit \`*.review.json\`.** Every change goes through \`eddie\`.
- **Preserve \`// eddie:<id>\` lines** in the .adoc (\`eddie-anchors\` skill).
- **Ask before \`apply --yes\`, \`delete\`, \`merge\`, \`strip\`** — they change the
  manuscript or remove review state.
- A document with several mappings (rounds, or several reviewers): commands use
  the newest unless you pass \`--mapping <id>\` or \`--round N\`; check with
  \`eddie rounds\`.
- Remarks are numbered per mapping (\`#7\`, shown with the reviewer's initials as
  \`#7 AC\`); use the number, not the id.

## Finishing

Summarise for the user: how many remarks you resolved, which you answered but
left open and why, and any you could not place. Then suggest
\`eddie report <file.adoc>\` (a Markdown report for the editor) and, once the PDF is
rebuilt, \`eddie stamp\` (see \`eddie-pipeline\`).

The full command list is in [references/commands.md](references/commands.md);
\`eddie help <command>\` prints any command's options.
`;
  return {
    name: "eddie-review",
    summary: "Work through an editor's remarks: read, edit, reply, resolve, apply",
    files: [
      { path: "SKILL.md", content: frontmatter("eddie-review", REVIEW_DESCRIPTION, version) + body },
      { path: "references/commands.md", content: COMMANDS_REFERENCE },
    ],
  };
}

function anchorsSkill(version: string): Skill {
  const body = `# Editing an anchored AsciiDoc manuscript

Lines like \`// eddie:a3f21c94\` bind an editor's PDF annotation to the block
below them. They are AsciiDoc comments: Asciidoctor drops them before rendering,
so they never reach a PDF or a delivered file. They are also the only thing
keeping each editorial mark attached to the right paragraph. Without them, a
rewrite silently moves marks to whatever text still resembles the editor's
original wording. Nothing visible breaks when a marker is lost, which is why
these rules matter.

## Rules

- **Rewrite the prose freely.** That is what the anchor is for: the mark stays
  attached however completely the text beneath the marker changes.
- **Never edit, renumber, reformat or reflow a marker line.** Carry it through
  verbatim, on its own line, including when rewriting a whole file. The line is
  matched strictly: lowercase \`eddie:\`, no space after the colon, a lower-case
  hex id. \`// Eddie: a3f21c94\` is not a marker; tidying the comment destroys the
  anchor.
- **Keep each marker immediately above its block**, and above any attribute list
  or title attached to that block (\`[#id]\`, \`[source,ruby]\`, \`[NOTE]\`,
  \`.Caption\`), never between an attribute line and its block.
- **Do not insert a new block between a marker and the block it anchors.** A
  marker binds to the first content line beneath it, so an inserted paragraph
  takes the mark.
- **Move markers with their block**, as one unit, when reordering.
- **Splitting a block:** the marker stays with the part the editor's remark is
  about.
- **Copying a block: delete the copied markers.** An id must appear once per
  file.
- **Delete a marker only when deleting the paragraph it anchors.** That mark is
  then genuinely homeless, and Eddie Doc will say so.
- **Several markers may stack above one block** (several marks, or several
  review rounds). Keep the whole stack.
- **Never add markers by hand.** Eddie Doc writes them when a PDF is mapped;
  \`eddie strip <file.adoc>\` removes them all, only when the user asks.

## Example

Before:

\`\`\`asciidoc
// eddie:c673e3ed
[#graph-intro]
A knowledge graph is a structured representation of information.
\`\`\`

Rewriting the sentence keeps the first two lines untouched:

\`\`\`asciidoc
// eddie:c673e3ed
[#graph-intro]
A knowledge graph represents information as entities and the relationships between them.
\`\`\`

## Afterwards

If you moved or rewrote anchored text, run \`eddie remap <file.adoc>\` so review
positions follow the new text. Review state lives in \`*.review.json\` files
(by default under \`.eddie/\`); it is generated, never hand-edited, and belongs in
the same commit as the manuscript change.
`;
  return {
    name: "eddie-anchors",
    summary: "Keep `// eddie:` markers intact when editing .adoc files",
    files: [{ path: "SKILL.md", content: frontmatter("eddie-anchors", ANCHORS_DESCRIPTION, version) + body }],
  };
}

function pipelineSkill(version: string): Skill {
  const body = `# Eddie Doc review round-trip

The cycle: render the AsciiDoc to PDF → an editor annotates it → **map** the
annotated PDF onto the source → work through the remarks (\`eddie-review\` skill)
→ **report** and **stamp** the answers back into a fresh render → repeat for the
next round.

Check the CLI first: \`eddie version\` (or use \`npx @eddie-doc/cli\` instead of
\`eddie\`). Settings come from \`.vscode/settings.json\` (\`eddieDoc.*\`), \`.eddie.json\`
or \`EDDIE_DOC_*\` variables; \`eddie config\` shows them and the workspace root.

## Map an annotated PDF

\`\`\`bash
eddie open ch04.adoc ~/Downloads/ch04-acme.pdf --origin "Acme" --type copyedit
\`\`\`

- First PDF for a document: round 1 is created.
- A second reviewer's copy of the **same draft**: run \`open\` again; it joins the
  current round as another mapping.
- The editor's marks on a **new draft**: add \`--new-round\`. Resolutions and
  replies carry forward to matching remarks.
- The same editor sent the chapter again with **more marks**:
  \`eddie append ch04.adoc more.pdf\` adds only the new ones to the mapping.
- \`open\` writes \`// eddie:\` anchor comments into the .adoc by default (they never
  render). Pass \`--no-anchor\` if the user does not want the source touched. Tell
  the user the source changed either way.
- If \`open\` warns that few annotations mapped, the PDF is probably for another
  file or a much older draft. Check with the user before going on.

Inspect: \`eddie rounds ch04.adoc\`, \`eddie rounds\` (whole workspace),
\`eddie status\`. Label a mapping or round:
\`eddie describe ch04.adoc --round-label "Copyedit" --received 2026-10-01\`.

## Send it back

\`\`\`bash
eddie report ch04.adoc                      # Markdown report into the round folder
asciidoctor-pdf -o build/ch04.pdf ch04.adoc
eddie stamp build/ch04.pdf ch04.adoc        # marks + replies written into a copy
\`\`\`

\`stamp\` never modifies the clean render; it prints where the stamped PDF went
and lists any mark it could not place. \`--all-in-round\` puts every reviewer of the
round on one PDF. With several reviewers, export one report per mapping
(\`--mapping <id>\`).

## Automate

- Everything prints results on stdout and messages on stderr; add \`--json\` to
  parse. Exit codes: 0 ok, 1 failed, 2 usage error.
- Commands that change the manuscript or delete review state need \`--yes\`
  without a terminal. Do not add \`--yes\` on the user's behalf unless they asked.
- Count open remarks:
  \`eddie list ch04.adoc --json | jq '[.items[] | select(.bucket != "resolved")] | length'\`
- Stamp every reviewed chapter after a build:

\`\`\`bash
for src in manuscript/*.adoc; do
  name=$(basename "$src" .adoc)
  asciidoctor-pdf -o "build/$name.pdf" "$src"
  eddie rounds "$src" >/dev/null 2>&1 && eddie stamp "build/$name.pdf" "$src" --all-in-round
done
\`\`\`

## Do not

- Hand-edit \`*.review.json\` or move files inside \`.eddie/\`; use \`eddie migrate\`
  to move old sidecars into the review folder.
- Run \`delete\`, \`merge\` or \`strip\` without the user's go-ahead.
- Commit the stamped PDF over the clean render.

\`eddie help\` lists every command; \`eddie help <command>\` shows its options.
`;
  return {
    name: "eddie-pipeline",
    summary: "Map new PDFs, manage rounds, export reports, stamp, automate in CI",
    files: [{ path: "SKILL.md", content: frontmatter("eddie-pipeline", PIPELINE_DESCRIPTION, version) + body }],
  };
}

/** Every command, one line each. A test holds it to the CLI's real command list. */
export const COMMANDS_REFERENCE = `# eddie command reference

Line numbers are 1-based. \`<item>\` is a remark number (\`7\` or \`#7\`) or an id.
Per-document commands use the newest mapping unless given \`--mapping <id>\` or
\`--round N\`. Add \`--json\` to any reading command. \`eddie help <command>\` has the
full options.

## Reviews and rounds

| Command | Does |
| --- | --- |
| \`eddie open <file.adoc> <annotated.pdf> [--new-round] [--origin O] [--no-anchor]\` | Map an annotated PDF onto the source. |
| \`eddie append <file.adoc> <more.pdf>...\` | Add more PDFs' marks to the mapping. |
| \`eddie merge <file.adoc> <mapping>... --into <mapping>\` | Fold mappings into one (asks first). |
| \`eddie rounds [file.adoc]\` | Rounds and mappings of a document, or of the workspace. |
| \`eddie describe <file.adoc> [--label L] [--round-label L] …\` | Label a mapping and its round. |
| \`eddie delete <file.adoc> --mapping M\` | Delete a mapping's sidecar (asks first). |
| \`eddie remap <file.adoc>\` | Re-match every round against the current text. |

## Annotations

| Command | Does |
| --- | --- |
| \`eddie list <file.adoc> [--bucket open,review,unmatched,resolved] [--text T]\` | Remarks grouped Open / Needs review / Unmatched / Resolved. |
| \`eddie show <file.adoc> <item>\` | One remark: comment, marked text, source lines, replies. |
| \`eddie resolve <file.adoc> <item>...\` / \`eddie reopen …\` | Mark done / open again. |
| \`eddie confirm <file.adoc> <item>...\` | Accept a doubtful or stale placement. |
| \`eddie relink <file.adoc> <item> <line>\` | Place a remark on a line by hand. |
| \`eddie remap-item <file.adoc> <item>\` | Re-match one remark automatically. |
| \`eddie triage <file.adoc> [-i]\` | Candidate lines for unmatched remarks. |
| \`eddie reply <file.adoc> <item> <text>\` | Answer a remark (\`--edit <id>\`, \`--delete <id>\`). |
| \`eddie preview <file.adoc> <item> [--open]\` | The PDF page a remark came from. |

## Editing the source

| Command | Does |
| --- | --- |
| \`eddie apply <file.adoc> [--dry-run] [--yes]\` | Apply every confident delete / replace / insert. |
| \`eddie fix <file.adoc> <item> [action] [--text T]\` | One remark's edit: delete-struck, delete-lines, replace-marked, insert-at-mark, insert-note. |
| \`eddie anchor <file.adoc>\` | Write \`// eddie:\` markers for placed remarks. |
| \`eddie strip <file.adoc>\` | Remove every marker. |

## Outputs

| Command | Does |
| --- | --- |
| \`eddie report <file.adoc> [-o out.md]\` | Markdown review report. |
| \`eddie stamp <fresh.pdf> <file.adoc> [--all-in-round]\` | Write marks and replies into a fresh render. |
| \`eddie extract <annotated.pdf>\` | Annotations as standalone AsciiDoc or JSON. |
| \`eddie map <annotated.pdf> <file.adoc>\` | Extract and match without saving. |

## Workspace

| Command | Does |
| --- | --- |
| \`eddie status\` | Every reviewed document with open counts. |
| \`eddie tui [file.adoc]\` | Full-screen browser (for people, not agents). |
| \`eddie skills [install, list, remove]\` | Install these agent skills for Claude Code, Codex, Cursor… |
| \`eddie folder\` / \`eddie migrate\` / \`eddie config\` / \`eddie version\` | Review folder, move old sidecars, settings, version. |
`;

/** Every skill Eddie Doc ships, stamped with `version`. */
export function eddieSkills(version: string): Skill[] {
  return [reviewSkill(version), anchorsSkill(version), pipelineSkill(version)];
}

/**
 * The version an installed `SKILL.md` was written by, or undefined when Eddie
 * Doc did not write it (a user's own skill of the same name).
 */
export function installedVersion(skillMd: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (!fm || !new RegExp(`^\\s+generator:\\s*${GENERATOR}\\s*$`, "m").test(fm)) return undefined;
  return /^\s+version:\s*"?([^"\n]+)"?\s*$/m.exec(fm)?.[1]?.trim() ?? "unknown";
}
