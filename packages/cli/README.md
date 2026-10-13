# @eddie-doc/cli

**Map an editor's PDF annotations back onto your AsciiDoc source, from the
command line.**

You write in AsciiDoc, render a PDF, and send it to an editor. It comes back
covered in highlights, strikethroughs, sticky notes and insert marks. `eddie`
reads those marks, finds the exact line each one refers to in your `.adoc`
source, and turns them into review items you can list, answer, resolve and
apply. It can then write the review back into a freshly rendered PDF, so the
editor sees your answers next to their own marks.

This is the command line of [Eddie Doc](https://volland.github.io/eddie-doc/).
It runs the same core as the
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=pavlyshyn.eddie-doc)
and the [Obsidian plugin](https://github.com/Volland/eddie-doc/blob/main/docs/OBSIDIAN.md),
and reads and writes the same review files. A review started in the editor can
be finished in a terminal, a CI job or an AI agent, and the other way round.

```console
$ eddie open chapter-04.adoc ~/Downloads/chapter-04-edited.pdf --origin "Acme Copyedit"
.eddie/manuscript/chapter-04/rev-1/chapter-04-edited.review.json
Revision 1 · Acme Copyedit — 31 annotation(s), 29 mapped to source

$ eddie list chapter-04.adoc --bucket open
Open (24)
  #1 AC    [Delete]     p2   L14        1.00 marker    Cut — repeats the intro.
  #2 AC    [Highlight]  p2   L19        0.94 fuzzy     Reword: 'trust or lineage'.
  …
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Choosing a document, mapping and annotation](#choosing-a-document-mapping-and-annotation)
- [Command reference](#command-reference)
- [Interactive mode: `eddie tui`](#interactive-mode-eddie-tui)
- [Configuration](#configuration)
- [Scripting: JSON output and exit codes](#scripting-json-output-and-exit-codes)
- [Recipes](#recipes)
- [Working with VS Code and Obsidian](#working-with-vs-code-and-obsidian)
- [Troubleshooting](#troubleshooting)

## Install

Node.js 18 or newer. The package has no runtime dependencies: PDF reading
(pdf.js) and PDF writing (pdf-lib) are bundled into it.

```bash
npm install -g @eddie-doc/cli     # installs `eddie` (and the long name `eddie-doc`)
eddie help

npx @eddie-doc/cli help           # or run it without installing
```

As a project dependency, so a build script pins the version:

```bash
npm install --save-dev @eddie-doc/cli
npx eddie stamp build/ch04.pdf src/ch04.adoc
```

**Already using the VS Code extension?** It ships this CLI. `eddie` is on the
PATH of every VS Code integrated terminal, and the command
**Eddie Doc: Install 'eddie' Command in PATH** links it into `~/.local/bin` for
other shells. That copy runs on VS Code's own runtime, so it needs no Node
install. See [Working with VS Code and Obsidian](#working-with-vs-code-and-obsidian).

## Quick start

```bash
# 1. Map the editor's annotated PDF onto your source.
eddie open src/ch04.adoc ~/Downloads/ch04-acme.pdf --origin "Acme" --type copyedit

# 2. See what came back, grouped the way the editor's tree groups it.
eddie list src/ch04.adoc

# 3. Read one remark in context, with the source lines it points at.
eddie show src/ch04.adoc 7

# 4. Answer, resolve, or fix it.
eddie reply   src/ch04.adoc 7 "Reworded — see the new second sentence."
eddie resolve src/ch04.adoc 7 8 12
eddie apply   src/ch04.adoc --dry-run      # every confident delete/replace/insert
eddie apply   src/ch04.adoc --yes

# 5. Link what the matcher could not place.
eddie triage src/ch04.adoc -i

# 6. Send it back: a report, and the review written into a fresh render.
eddie report src/ch04.adoc
asciidoctor-pdf -o build/ch04.pdf src/ch04.adoc
eddie stamp build/ch04.pdf src/ch04.adoc
```

Every step writes to the review folder (`.eddie/` by default). Your manuscript
changes only when you ask: `apply`, `fix`, `anchor` and `strip`. The exception
is `open`, which adds invisible anchor comments unless you pass `--no-anchor`;
see [Anchors](#anchors).

## Concepts

### Source, annotated PDF, clean render

- **Source**: the `.adoc` file you write.
- **Annotated PDF**: a PDF rendered from the source that an editor marked up in
  Acrobat, Preview, PDF Expert, Zotero or similar. Highlights, strikeouts,
  underlines, sticky notes, free-text notes, carets (insert marks) and
  replacement marks are read.
- **Clean render**: a new PDF built from the current source, with no marks.
  `stamp` writes the review into a copy of it and never modifies the original.

### Mapping

One annotated PDF mapped onto one source is a **mapping**. It is stored as a
JSON **sidecar** file, `<mapping-id>.review.json`, which holds every annotation,
where it was matched in the source, and your state: resolved flags, replies,
hand-made links and anchors. The id comes from the PDF's file name
(`ch04-acme.annotated.pdf` → `ch04-acme`).

More PDFs can be added to an existing mapping with `append`, for example when
the editor sends the chapter again with more marks. Marks the mapping already
has are skipped, and new ones continue its numbering.

### Rounds

A **round** (also called a revision) groups the mappings that came back from one
pass over the manuscript. Two editors marking the same draft give two mappings
in one round. When the next draft comes back, `open --new-round` starts round 2
and carries your resolved flags, replies and links forward by matching each
remark's content, because a re-exported PDF changes every annotation's internal
id.

### The review folder

Everything goes under one folder at the workspace root, laid out to mirror the
manuscript, so the manuscript folder itself never gains a file:

```text
manuscript/chapter-04.adoc          ← your source

.eddie/manuscript/chapter-04/
  rev-1/
    acme.review.json                ← one mapping
    acme.review.md                  ← its exported report
    pdf/acme.pdf                    ← imported PDF (opt-in) and stamped PDFs
  rev-2/
    acme.review.json
    beta-proofread.review.json      ← a second reviewer in the same round
```

Set `reviewFolder` to `""` to use the old layout instead, with
`<file>.review.json` beside each `.adoc`. Paths inside a sidecar are relative to
the sidecar, so the folder can be moved or committed as it is.

### Buckets

Every annotation is in exactly one group, as in the editors:

| Bucket | Meaning |
| --- | --- |
| `open` | Placed in the source with confidence; waiting for you. |
| `review` | Placed, but the match is below `highConfidence`, or **stale** (the text it was linked to has changed). Check it, then `confirm` or `relink`. |
| `unmatched` | No place found. Link it with `triage` or `relink`. |
| `resolved` | Done. |

### Remark numbers

Each annotation gets a number when it is first mapped, shown as `#7 AC` (number
and the reviewer's initials). The number never changes, so you and the editor can
refer to "#7" across emails, reports and rounds. Most commands accept it as
`7` or `#7`.

### Anchors

When a PDF is mapped, the source text still matches what the editor read, which
is the most reliable moment for matching. By default `open` then writes an
AsciiDoc comment line above each marked paragraph:

```asciidoc
// eddie:c673e3ed
A knowledge graph is a structured representation of information where entities
are connected by well-defined relationships.
```

Asciidoctor drops comment lines, so markers never appear in the rendered output.
They keep each annotation attached to its paragraph when you rewrite the text,
including edits made outside any Eddie tool. Without markers, re-matching falls
back to block ids, block fingerprints and text similarity. `eddie strip` removes
every marker; `--no-anchor` (or `autoAnchor: false`) skips writing them.

### Match methods

`show` and `list` print how each annotation was placed, most trusted first:

| Method | How |
| --- | --- |
| `marker` | Its `// eddie:` comment was found. |
| `blockId` | The enclosing `[#id]` block was found. |
| `fingerprint` | The enclosing block's content hash still matches. |
| `fuzzy` | Token similarity to the text under the mark. |
| `lexical` | Character-trigram similarity; finds words that were inflected, hyphenated or misspelled. |
| `semantic` | Embedding similarity, through a local Ollama server (opt-in). |
| `manual` | You linked it by hand. |

## Choosing a document, mapping and annotation

Most commands take the **source** as their first argument: `eddie list ch04.adoc`.

A source with several mappings: commands act on the **newest** one (shown with
`*` in `eddie rounds`). To choose another:

```bash
eddie rounds ch04.adoc                         # see what exists
eddie list ch04.adoc --round 1                 # newest mapping in round 1
eddie list ch04.adoc --mapping beta-proofread  # by id (newest round that has it)
eddie list ch04.adoc --mapping rev-1/acme      # exact round/id
eddie list ch04.adoc --mapping "Acme"          # by label or origin
```

**Annotations** are named by remark number (`7`, `#7`), full id
(`p4-highlight-72-506`), or a unique id prefix.

## Command reference

`eddie help` lists every command, and `eddie help <command>` (or
`eddie <command> --help`) prints its full usage. The equivalent VS Code
command is given for each.

### Reviews and rounds

#### `open` — map an annotated PDF onto its source

```text
eddie open <source.adoc> <annotated.pdf>
           [--new-round | --round N] [--label L] [--origin O] [--reviewer R]
           [--type copyedit|proofread|developmental|technical|legal|other]
           [--role annotated|proof|clean|stamped|other] [--import] [--no-anchor]
```

Reads every mark, matches it to the source, writes the mapping, and anchors the
marks (unless `--no-anchor`). By default the PDF joins the document's current
round. `--new-round` starts the next round and carries state forward; `--round N`
targets a specific round. Opening the same PDF again in the same round updates
that mapping instead of creating a second one. `--import` copies the PDF into the
round's `pdf/` folder, so the round stays readable after your downloads folder is
cleared. If fewer than 40% of five or more marks are placed, a warning suggests
checking that the PDF belongs to this source. *VS Code: Open PDF Review, Start
New Review Round, Add Annotated PDF to Current Round.*

```bash
eddie open ch04.adoc ch04-acme.pdf --origin Acme --reviewer "J. Smith" --type copyedit
eddie open ch04.adoc ch04-beta.pdf                       # second editor, same round
eddie open ch04.adoc ch04-acme-v2.pdf --new-round        # the next draft came back
```

#### `append` — add more PDFs to an existing mapping

```text
eddie append <source.adoc> <file.pdf>... [--mapping M] [--origin O] [--reviewer R] [--role R] [--import]
```

New marks join the mapping and continue its numbering. Marks it already has are
skipped, and adding a byte-identical PDF a second time does nothing. *VS Code:
Add PDFs to This Mapping.*

#### `merge` — fold mappings into one

```text
eddie merge <source.adoc> <mapping>... --into <mapping> [--yes]
```

Moves the PDFs, marks, replies and resolutions of each listed mapping into the
`--into` mapping (default: the newest), then deletes their sidecars. The target
is written to disk before anything is deleted. Asks for confirmation; `--yes`
skips the question. *VS Code: Merge Mappings into This One.*

#### `rounds` (alias `mappings`) — list rounds and mappings

```text
eddie rounds [source.adoc] [--json]
```

Each round with its mappings, the counts per bucket, and each sidecar path.
Without a source, every mapping in the workspace, grouped by document. To browse
them interactively, use [`eddie tui`](#interactive-mode-eddie-tui). *VS Code:
Switch Round / Mapping.*

#### `describe` (alias `edit-round`) — label a mapping and its round

```text
eddie describe <source.adoc> [--mapping M] [--label L] [--origin O] [--reviewer R]
               [--type T] [--role R] [--round-label L] [--received YYYY-MM-DD] [--round-note N]
```

An empty value clears a field (`--label ''`). Round fields apply to every
mapping in the round. *VS Code: Edit Round Details.*

#### `delete` (aliases `delete-mapping`, `rm`) — remove a mapping

```text
eddie delete <source.adoc> --mapping M [--yes]
```

Deletes the sidecar only. The source, PDFs and reports are left in place.
`--mapping` or `--round` is required. *VS Code: Remove This Mapping.*

#### `remap` (alias `refresh`) — re-match after editing the source

```text
eddie remap <source.adoc> [--only-changed]
```

Re-runs matching for every mapping of the document against the current text,
using the annotations already extracted (the PDF is not read again). Run it after
editing the source outside an Eddie-aware editor. Annotations whose text has
changed too much are flagged stale and stay at their last known position rather
than being moved to a guess. *VS Code: Re-map Annotations.*

### Annotations

#### `list` (alias `ls`) — what the editor said, grouped

```text
eddie list <source.adoc> [--mapping M] [--bucket open,review,unmatched,resolved]
           [--kind highlight,strikeout,underline,comment,insert,replace,other]
           [--page N] [--text T] [--hide-resolved] [--json]
```

`--text` searches comments, marked text, authors and notes. `--kind delete` is
accepted for `strikeout`. Without `--json` the counts summary goes to stderr and
the groups to stdout. *VS Code: the PDF Annotations tree.*

#### `show` — one annotation in full

```text
eddie show <source.adoc> <item> [--mapping M] [--context N] [--json]
```

Prints the editor's comment, the marked text, the source lines it points at with
`N` lines of context (default 1), how it was matched, its anchor, and the reply
thread with reply ids. *VS Code: Reveal in Source and the comment thread.*

#### `resolve`, `reopen` (alias `unresolve`), `confirm`

```text
eddie resolve <source.adoc> <item>... [--mapping M]
eddie reopen  <source.adoc> <item>... [--mapping M]
eddie confirm <source.adoc> <item>... [--mapping M] [--all-located]
```

`resolve` and `reopen` set the resolved state (running either twice does
nothing more). `confirm` vouches for a low-confidence or stale match, which moves
it out of *Needs review*. `--all-located` applies to every annotation that has a
place in the source. *VS Code: Toggle Resolved, Confirm Match.*

#### `relink` — link an annotation by hand

```text
eddie relink <source.adoc> <item> <line> [--mapping M]
```

`<line>` is 1-based, as editors number lines. A hand-made link counts as
confirmed and overrides automatic matching until you run `remap-item`. *VS Code:
Re-link to Current Cursor Line, Reselect Source Line.*

#### `remap-item` — re-match one annotation

```text
eddie remap-item <source.adoc> <item> [--mapping M]
```

Drops any manual link and matches again. If the annotation has an anchor that
still resolves, the anchor is used. Exits with 1 when no confident place is found.
*VS Code: Re-map This Annotation.*

#### `triage` — place the unmatched

```text
eddie triage <source.adoc> [--mapping M] [--candidates N] [-i | --interactive] [--json]
```

For each unmatched, unresolved annotation, prints a ranked shortlist of candidate
lines (5 by default). With `-i`, asks about each one in turn: a candidate number
to link it, `L<line>` for any line, `s` to skip, `q` to stop. Without `-i` it
only prints; link the annotations afterwards with `relink`. *VS Code: Triage
Unmatched Annotations.*

#### `reply` — the conversation under a mark

```text
eddie reply <source.adoc> <item> <text...>             # add; prints the new reply id
eddie reply <source.adoc> <item> -                     # add, reading the text from stdin
eddie reply <source.adoc> <item> --edit <reply-id> <text...>
eddie reply <source.adoc> <item> --delete <reply-id>
            [--mapping M] [--author NAME]
```

Replies are saved in the sidecar, included in reports, and written into stamped
PDFs as threaded replies under the editor's mark. The author is `--author`, else
the `authorName` setting, else `git config user.name`, else your login name. The
editor's own mark cannot be edited, because it came from the PDF. *VS Code:
Reply, Edit Reply, Delete Reply.*

#### `preview` — where in the PDF

```text
eddie preview <source.adoc> <item> [--mapping M] [--open]
```

Prints `path/to/file.pdf#page=N`. `--open` opens the PDF with the system viewer.
*VS Code: Preview in PDF.*

### Editing the source

#### `apply` — apply every confident edit

```text
eddie apply <source.adoc> [--mapping M] [--dry-run] [--yes] [--json]
```

Applies, in one write: struck text is deleted; highlighted, underlined or
replacement marks whose note contains a suggestion (`Reword: 'trust or lineage'`,
`Replace with "graph"`) are replaced with it; insert marks get their text. Only
unresolved annotations that are placed precisely and at or above `highConfidence`
are touched. Applied annotations are marked resolved and positions are re-matched.
The plan is printed first. In a terminal you are asked to confirm; elsewhere
`--yes` is required, otherwise nothing is written and the exit code is 1.
Overlapping edits are refused; apply those one at a time with `fix`. *VS Code:
Apply All Confident Edits.*

#### `fix` — one annotation's quick fix

```text
eddie fix <source.adoc> <item>                         # list available actions
eddie fix <source.adoc> <item> <action> [--text T] [--dry-run] [--keep-open]
```

| Action | For | Does |
| --- | --- | --- |
| `delete-struck` | strikeouts | Deletes exactly the struck words and one adjacent space. |
| `delete-lines` | strikeouts | Deletes the whole source lines the mark covers. |
| `replace-marked` | strikeouts, highlights and underlines with a note | Replaces the marked words with `--text`, or the note's suggestion. |
| `insert-at-mark` | carets | Inserts `--text`, or the note's suggestion, at the caret. |
| `insert-note` | any mark with a comment | Adds the editor's note above the line as a `// ✎` AsciiDoc comment. |

Prints the change as `-`/`+` lines. Afterwards the annotation is resolved, except
with `insert-note` or `--keep-open`. *VS Code: the lightbulb Quick Fixes.*

#### `anchor` — pin marks to their paragraphs

```text
eddie anchor <source.adoc> [--mapping M] [--dry-run]
eddie anchor <source.adoc> --review <sidecar.json> [--dry-run]
```

Writes `// eddie:<id>` markers for every placed annotation of the mapping that
does not have one yet, then re-matches through them. The `--review` form works on
one sidecar file directly, without a review folder. *VS Code: Anchor Annotations
in Source.*

#### `strip` — remove the markers

```text
eddie strip <source.adoc> [--dry-run]
```

Removes every `// eddie:` line. Annotations then fall back to block ids,
fingerprints and text matching. Use it before you hand off a source file that
must not contain the markers. *VS Code: Remove Source Anchors.*

### Outputs

#### `report` (alias `export`) — a Markdown report for the editor

```text
eddie report <source.adoc> [--mapping M] [-o out.md | --stdout] [--no-resolved]
```

Groups annotations as Open, Needs review, Unmatched and Resolved, with line
numbers, comments and your replies. It warns when the source or PDF has changed
since the mapping was made. Written to the round folder
(`rev-1/<mapping>.review.md`), or beside the source with
`reportOutput: besideSource`, or to `-o`. The sidecar records where it was
written. With several editors in one round, export one report per mapping. *VS
Code: Export Review Report.*

#### `stamp` — write the review into a fresh render

```text
eddie stamp <fresh.pdf> <source.adoc> [--mapping M | --all-in-round] [-o out.pdf] [--no-resolved]
eddie stamp <fresh.pdf> --review <sidecar.json>... [-o out.pdf] [--no-resolved] [--fail-on-unstamped]
```

Places every mark and reply as a real PDF annotation in a copy of the clean
render. Positions are worked out again from the current source text, never taken
from the old PDF's coordinates, so page breaks, font and theme changes do not
matter. Where the marked words were since rewritten, the mark falls back to the
line or paragraph and says so in its comment. A mark that cannot be placed at all
is listed on stderr rather than put somewhere approximate. `--all-in-round` puts
every mapping of the round onto one PDF. Resolved marks are drawn faintly, or
left out with `--no-resolved`.

By default the output goes to the round's `pdf/` folder (`stampOutput:
besidePdf` puts it next to the clean render as `<name>.reviewed.pdf`). The
`--review` form needs no workspace, takes any number of sidecars, writes next to
the clean render, and with `--fail-on-unstamped` exits with 1 when anything could
not be placed, which suits a build gate. Refuses to overwrite the clean render.
*VS Code: Stamp Reviewed PDF.*

#### `extract` — the marks, without a source

```text
eddie extract <annotated.pdf> [-o out.adoc | --stdout] [--json]
```

Writes every annotation, with the text around it, to a standalone AsciiDoc file
(`<name>.annotations.adoc`), or prints the raw extraction as JSON. Nothing is
matched and no review is created. *VS Code: Extract Annotations as AsciiDoc.*

#### `map` — inspect matching without saving

```text
eddie map <annotated.pdf> <source.adoc> [--json] [--report] [--lexical]
```

Extracts and matches, prints the result, and writes nothing. `eddie a.pdf b.adoc`
is accepted as a short form.

### Workspace

| Command | Does |
| --- | --- |
| `eddie tui [source.adoc]` (aliases `browse`, `ui`) | Full-screen browser; see [Interactive mode](#interactive-mode-eddie-tui). |
| `eddie status` (alias `reviews`) | Every reviewed document in the workspace, with open counts, rounds and the newest mapping. *VS Code: Switch Review.* |
| `eddie folder [source.adoc] [--open]` | The review folder, or one document's folder in it. *VS Code: Open Review Folder.* |
| `eddie migrate [--dry-run] [--yes]` | Moves old-layout sidecars (beside each `.adoc`) into the review folder, rewriting their relative paths. *VS Code: Move Reviews into Review Folder.* |
| `eddie config [--json]` | The workspace root, each effective setting and where it came from. |
| `eddie version` | The version. It matches the extension and plugin release that writes the same format. |

### Global options

| Option | Meaning |
| --- | --- |
| `--root DIR` | Workspace root. Default: the nearest folder above the current directory containing `.eddie.json`, `.vscode`, `.eddie` or `.git`. This is the folder VS Code would have open, so both put files in the same place. |
| `-m, --mapping M` | Which mapping (see above). |
| `-r, --round N` | Which round. |
| `--review-folder DIR` | Override `reviewFolder`. |
| `--threshold X` | Override `matchThreshold`. |
| `--set key=value` | Override any setting; can be repeated. |
| `--author NAME` | Name on replies. |
| `--json` | Machine-readable output on stdout. |
| `--dry-run` | Show what would change; write nothing. |
| `-y, --yes` | Do not ask before changing the manuscript or deleting. |
| `-q, --quiet` | Fewer notices on stderr. |
| `-h, --help` | Help. |

## Interactive mode: `eddie tui`

```bash
eddie tui                 # every reviewed document in the workspace
eddie tui src/ch04.adoc   # straight to one document
```

A full-screen browser for the terminal, the counterpart of the editor's
sidebar. It goes **documents → mappings (rounds) → annotations**. A level with
only one choice is skipped. The annotation list is grouped Open / Needs review /
Unmatched / Done. Below it, the selected remark is shown with the editor's
comment, the marked words, the source lines it points at, and the reply thread.

```text
 eddie · book/chapter-01.adoc › Revision 1 · Acme
  #3 A    OPEN      Comment   L22    Add a small diagram illustrating this edge.
  #4 A    OPEN      Highlight L30    Reword: 'trust or lineage'.
› #1 A    DONE      Highlight L7     Strong framing — keep this.  ↳1
  #2 A    DONE      Delete    L12    Delete: too advanced for an intro.
──────────────────────────────────────────────────────────────────────────────
#1 A  Highlight  Resolved  page 2 · line 7, marker 1.00
Editor: Strong framing — keep this.
marked: relationships at the center of the model
▌    7 │ A knowledge graph is a structured representation of information where…
▌    8 │ are connected by well-defined relationships. Unlike a relational data…
  ↳ VP · 2026-10-13
    Fixed in the next draft
 r resolve  c confirm  a reply  l link  t triage  f fix  o pdf  b group  / search
```

| Key | Where | Does |
| --- | --- | --- |
| `↑` `↓` / `j` `k`, `PgUp` `PgDn`, `g` `G` | everywhere | Move. |
| `Enter` / `→` | everywhere | Open. On an annotation: its replies, or triage if it is unmatched. |
| `Esc` / `←` / `Backspace` | everywhere | Back. |
| `q`, `Ctrl-C` | everywhere | Quit. |
| `?` | everywhere | All keys. |
| `R` | mappings | Re-map every round of the document. |
| `p` | mappings | Export the mapping's report. |
| `r` | annotations | Resolve / reopen. |
| `c` | annotations | Confirm the match. |
| `a` | annotations | Add a reply (typed in the footer; `Esc` cancels). |
| `e` | annotations | Edit or delete a reply. |
| `l` | annotations | Link to a line number. |
| `t` | annotations | Ranked candidate lines; pick one to link. |
| `m` | annotations | Re-match automatically. |
| `f` | annotations | The mark's quick fixes; shows the diff and asks before writing. |
| `A` | annotations | Apply every confident edit, after showing the plan. |
| `o` | annotations | Open the PDF. |
| `b` / `/` / `h` | annotations | Filter by group (cycles) / search text / hide resolved. |

Every action saves immediately, to the same files the other commands use, so an
open VS Code window updates. Set `NO_COLOR=1` for monochrome. `tui` needs an
interactive terminal; in scripts use `list`, `show` and `rounds`.

## Configuration

The CLI reads the same settings as the editors, with the same names and
defaults, so a project configured for VS Code needs no further setup. From
lowest to highest priority:

1. Built-in defaults.
2. `.vscode/settings.json` in the workspace root: the `eddieDoc.*` keys. The
   file can contain comments and trailing commas, as VS Code allows.
3. `.eddie.json` in the workspace root, for projects without VS Code. Keys can be
   written as `reviewFolder`, `review-folder` or `review_folder`.
4. Environment variables `EDDIE_DOC_<SETTING>`, e.g.
   `EDDIE_DOC_REVIEW_FOLDER=reviews`, `EDDIE_DOC_AUTO_ANCHOR=false`.
5. Command-line flags: `--set key=value`, `--review-folder`, `--threshold`.

```json
// .eddie.json
{
  "reviewFolder": "reviews",
  "authorName": "Volodymyr Pavlyshyn",
  "highConfidence": 0.8,
  "autoAnchor": true
}
```

`eddie config` shows where each value came from.

| Setting | Default | Meaning |
| --- | --- | --- |
| `reviewFolder` | `.eddie` | Folder holding every review file. Relative to the workspace root; `""` puts sidecars beside each `.adoc`. |
| `importPdfs` | `false` | Copy each annotated PDF into its round's `pdf/` folder when mapped. |
| `stampOutput` | `reviewFolder` | Where `stamp` writes: `reviewFolder` or `besidePdf`. |
| `reportOutput` | `reviewFolder` | Where `report` writes: `reviewFolder` or `besideSource`. |
| `matchThreshold` | `0.5` | Minimum similarity (0–1) to link an annotation automatically; below it the annotation is unmatched. |
| `highConfidence` | `0.75` | Score at or above which a link counts as confident. Below it the annotation goes to *Needs review* and `apply` skips it. |
| `autoAnchor` | `true` | Write `// eddie:` markers when a PDF is mapped. |
| `showResolved` | `true` | `false` hides resolved annotations from `list`. |
| `lexicalFallback` | `true` | Use character-trigram matching for annotations the token matcher could not place. Runs locally. |
| `lexicalThreshold` | `0.6` | Minimum score for the lexical fallback. |
| `semanticFallback` | `false` | Use embedding similarity from a local [Ollama](https://ollama.com) server for annotations still unplaced. |
| `ollamaUrl` | `http://localhost:11434` | Ollama server for the semantic fallback. |
| `embedModel` | `embeddinggemma` | Embedding model (`ollama pull <model>` first). |
| `semanticThreshold` | `0.62` | Minimum cosine similarity for the semantic fallback. |
| `authorName` | *(git user.name)* | Name on your replies. |

`inlineMarkers` and `expandThreads` are read but only affect the editors.
Embeddings for the semantic fallback are cached in
`$XDG_CACHE_HOME/eddie-doc/embed-cache.json` (default `~/.cache/eddie-doc/`).

## Scripting: JSON output and exit codes

Results go to **stdout** and progress, warnings and summaries go to **stderr**,
so the output of any command can be piped. With `--json`, stdout carries one
JSON document.

```bash
# How many annotations are still open?
eddie list ch04.adoc --json | jq '[.items[] | select(.bucket != "resolved")] | length'

# The id of every unmatched remark.
eddie list ch04.adoc --bucket unmatched --json | jq -r '.items[].number'

# Accept the top triage suggestion for every unmatched remark scoring 0.7 or more.
eddie triage ch04.adoc --json \
  | jq -r '.[] | select(.candidates[0].score >= 0.7) | "\(.number) \(.candidates[0].line)"' \
  | while read n line; do eddie relink ch04.adoc "$n" "$line"; done
```

An annotation in `--json` output (from `list`, `show`, `relink`, `remap-item`):

```json
{
  "id": "p4-highlight-72-506",
  "number": 4,
  "initials": "A",
  "kind": "highlight",
  "bucket": "open",
  "page": 4,
  "line": 30,
  "endLine": 31,
  "score": 1,
  "method": "marker",
  "resolved": false,
  "confirmed": false,
  "stale": false,
  "author": "Editor",
  "comment": "Reword: 'trust or lineage'.",
  "markedText": "confidence score or a provenance record",
  "anchoredText": "…a confidence score or a provenance record…",
  "anchor": "9b1f3c20",
  "replies": [{ "id": "r-de401251", "author": "VP", "createdAt": "2026-10-13T09:12:44.000Z", "body": "Done." }]
}
```

Line numbers are 1-based throughout. `null` means the annotation is unmatched.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The command could not do what was asked: a file is missing, a document has no review, a confirmation was refused, nothing was placed by `remap-item`, or `stamp --fail-on-unstamped` left marks out. |
| `2` | Usage error: unknown command, missing argument, invalid flag value. |

The review files themselves follow a documented format with a JSON Schema:
[FORMAT.md](https://github.com/Volland/eddie-doc/blob/main/docs/FORMAT.md).

## Recipes

### Stamp every chapter after a build

```bash
#!/usr/bin/env bash
set -euo pipefail
for src in manuscript/*.adoc; do
  name=$(basename "$src" .adoc)
  asciidoctor-pdf -o "build/$name.pdf" "$src"
  # Only chapters that have a review.
  if eddie rounds "$src" >/dev/null 2>&1; then
    eddie stamp "build/$name.pdf" "$src" --all-in-round
  fi
done
```

### Fail CI while remarks are open

```yaml
# .github/workflows/review.yml
name: review
on: [pull_request]
jobs:
  open-remarks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g @eddie-doc/cli
      - name: No open remarks on reviewed chapters
        run: |
          open=0
          for src in manuscript/*.adoc; do
            eddie rounds "$src" >/dev/null 2>&1 || continue
            n=$(eddie list "$src" --json | jq '[.items[] | select(.bucket != "resolved")] | length')
            echo "$src: $n open"
            open=$((open + n))
          done
          test "$open" -eq 0
```

### A round from start to finish, without an editor

```bash
eddie open ch04.adoc acme.pdf --new-round --origin Acme --type copyedit
eddie apply ch04.adoc --yes                     # take the mechanical edits
eddie triage ch04.adoc -i                       # place the rest
eddie list ch04.adoc --bucket open,review       # what still needs a decision
eddie reply ch04.adoc 12 "Kept: the term is defined in chapter 2."
eddie resolve ch04.adoc 12
eddie report ch04.adoc
asciidoctor-pdf -o build/ch04.pdf ch04.adoc && eddie stamp build/ch04.pdf ch04.adoc
```

### With an AI coding agent

Every command can run without prompts (`--yes`) and produce JSON (`--json`), so
an agent can work through a review: list the open remarks, read each with
`eddie show`, edit the prose, then `eddie reply` and `eddie resolve`. The
remarks it handles show up as answered in VS Code and Obsidian, and in the
stamped PDF.

```text
Work through the open remarks on manuscript/ch04.adoc with the `eddie` CLI:
`eddie list manuscript/ch04.adoc --bucket open,review --json`, then for each:
`eddie show … <n>`, make the edit, `eddie reply … <n> "<what you changed>"`,
`eddie resolve … <n>`. Leave remarks you disagree with open, with a reply
explaining why.
```

## Working with VS Code and Obsidian

- **Same files.** The CLI, the VS Code extension and the Obsidian plugin read and
  write the same version 3 sidecars. Edit a review in any of them and the others
  pick the changes up; VS Code and Obsidian merge changes made on disk while they
  are open.
- **Same location.** The CLI finds the workspace root and reads
  `.vscode/settings.json` the way VS Code does, so `.eddie/` ends up in the same
  place. The Obsidian plugin's default folder is `Eddie Reviews`; to share a
  vault, run the CLI with `--review-folder "Eddie Reviews"` or put it in
  `.eddie.json`.
- **Bundled with the extension.** The VS Code extension includes this CLI:
  - `eddie` is on the PATH of every integrated terminal (setting
    `eddieDoc.cli.addToTerminalPath`, on by default).
  - **Eddie Doc: Install 'eddie' Command in PATH** links it into `~/.local/bin`
    (on Windows it shows the folder to add to PATH).
  - **Eddie Doc: Open Terminal with Eddie CLI** opens a terminal in the workspace
    and runs `eddie status`.

  That copy runs on VS Code's own runtime, so it needs no Node install. Set
  `EDDIE_NODE=/path/to/node` to run it on a different Node.
- **One version.** The npm package, the extension and the plugin are released
  together under one version number. `eddie version` prints it, and each sidecar
  records the version that wrote it.

## Troubleshooting

**"no review for ch04.adoc".** Nothing has been mapped for this source yet, or
the review lives somewhere else. Check `eddie config` (is the root what you
expect, and is `reviewFolder` the one the editor uses?) and `eddie status`.

**Most annotations are unmatched.** The PDF is probably from a different source
file, or from a much older draft. Compare with `eddie map annotated.pdf ch04.adoc`.
Otherwise, use `eddie triage -i`, or lower `--threshold`, or enable
`semanticFallback` for paraphrased remarks.

**An annotation is stale.** The paragraph it was linked to changed too much. It
stays at its last known position in *Needs review*. Check it with `eddie show`,
then `eddie confirm` it or `eddie relink` it.

**`apply` refuses to run.** Without a terminal it needs `--yes`. If edits
overlap, apply them one at a time with `eddie fix`.

**Seeing pdf.js warnings.** They are hidden by default. Set `EDDIE_DEBUG=1` to
show them.

## License

MIT. Part of [Eddie Doc](https://github.com/Volland/eddie-doc) by Volodymyr
Pavlyshyn.
