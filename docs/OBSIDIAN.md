# Eddie Doc for Obsidian

Eddie Doc reads the annotated PDF your editor sends back, recovers the text under each highlight, strikethrough and comment, and maps every mark to the line of your AsciiDoc source it came from. In Obsidian the marks show up in a review panel and as markup in the editor, and you reply to them, resolve them and apply the simple ones to the source from there.

This guide covers the Obsidian plugin. For the VS Code extension, see the [README](../README.md). Both use the same core and the same on-disk format, so a review started in one can be continued in the other.

> **Status: first stable release (1.4.0). Tested on desktop Obsidian and tried on a phone by the maintainer.**
> It is installable from GitHub releases and through BRAT, and is not yet in Obsidian's community plugin list. The phone test was a hands-on try, not a measured one: there are no timings, and a roughly 300-page PDF on a phone has not been characterised.
>
> **Checked in a running Obsidian** (macOS, versions 1.8.4 and 1.13.7, 65 automated checks each, `npm run e2e:obsidian`): the plugin loads and registers its 32 commands and both views; it claims `.adoc` when nothing else holds it; mapping the sample PDF through the picker finds all 5 annotations with PDF parsing in a Blob worker; the sidecar, copied PDF and anchors are written where they should be; the panel, thread, reply (with the one-time name prompt), resolve and status bar work; Eddie's PDF viewer draws the right page with the marker on it; "Delete struck text" removes exactly the struck words and one Undo restores them; a reply written into the sidecar from outside shows up; renaming the manuscript or the review folder keeps the review attached; commands are hidden when they cannot apply; disabling and re-enabling is clean; and with [AsciiDoc Live](https://github.com/koshlensky/asciidoc-live) 1.0.1 installed, Eddie leaves `.adoc` to it, opens its own source tab beside it on Reveal, and AsciiDoc Live's preview follows edits made there. The phone layout was checked with Obsidian's mobile emulation (44 px targets, list and thread shown one at a time).
>
> **Found by that testing:** Obsidian 1.8.4's built-in PDF viewer opens the right page but does not draw the `&rect=` rectangle, so Eddie's own viewer is the default. Obsidian 1.13.7 asks whether you trust a vault's author the first time you open a vault that ships plugins; nothing loads until you accept.
>
> **Not checked:**
>
> - phones and tablets beyond the maintainer's hands-on try: both platforms, PDF parsing memory, and speed on a roughly 300-page PDF
> - Windows and Linux
> - how it behaves alongside Obsidian Sync, iCloud, Syncthing and similar
> - the other AsciiDoc plugins (Asciidoctor editor, Asciidoc Reader)
>
> Expect rough edges, and please [report them](https://github.com/Volland/eddie-doc/issues).

## Contents

1. [What it is and who it is for](#what-it-is-and-who-it-is-for)
2. [Install](#install)
3. [Five-minute walkthrough](#five-minute-walkthrough)
4. [The review panel](#the-review-panel)
5. [The editor markup](#the-editor-markup)
6. [Anchors](#anchors)
7. [Rounds and mappings](#rounds-and-mappings)
8. [Where files live](#where-files-live)
9. [AsciiDoc files in Obsidian](#asciidoc-files-in-obsidian)
10. [Mobile](#mobile)
11. [Commands](#commands)
12. [Settings](#settings)
13. [Troubleshooting](#troubleshooting)
14. [Privacy](#privacy)
15. [Limitations](#limitations)
16. [FAQ](#faq)
17. [Relation to the VS Code extension](#relation-to-the-vs-code-extension)

## What it is and who it is for

You write a book or a paper in AsciiDoc, build a PDF, and send it to an editor. They send back an annotated PDF: highlights, strikethroughs, sticky notes, rewrite requests. Reconciling those marks with the `.adoc` by hand is slow.

Eddie Doc does the reconciling. Each mark becomes a review item linked to a source line. You work through the items, reply to the editor's remarks, resolve them, and send a report back.

It is for authors and editors who already keep their writing in an Obsidian vault, on desktop or on a phone, and want to do the review pass there. It assumes you know the basics of Obsidian (vault, plugins folder, command palette) and does not assume you know Eddie Doc.

Eddie Doc does not render AsciiDoc. It works on the source text. If you want a preview of the formatted document, use another AsciiDoc plugin alongside it (see [AsciiDoc files in Obsidian](#asciidoc-files-in-obsidian)).

Words used in this guide:

| Term | Meaning |
| --- | --- |
| Reviewer | The person who annotated the PDF (copy editor, proofreader) |
| Mapping | One annotated PDF matched onto one AsciiDoc file, stored as one review sidecar |
| Round | One revision of the manuscript under review (`rev-1`, `rev-2`, ...). A round holds one mapping per annotated PDF returned for it |
| Review sidecar | The `<mapping>.review.json` file that records every annotation of one mapping, where it landed in the source, and its resolution state |

## Install

Releases are on [GitHub](https://github.com/Volland/eddie-doc/releases); the Obsidian files are on the release whose tag is the bare version number (for example `1.4.0`).

### Manual install

1. Download `main.js`, `manifest.json` and `styles.css` from the release whose tag has no `v` (for example `1.4.0`) on the [GitHub releases page](https://github.com/Volland/eddie-doc/releases).
2. Put the three files in `<your vault>/.obsidian/plugins/eddie-doc/`. Create the folder if it does not exist.
3. In Obsidian, open Settings, Community plugins, turn off Restricted mode if it is on, and enable Eddie Doc.

The plugin needs Obsidian 1.7.2 or later (the newest API it calls is `Workspace.revealLeaf`'s promise form, added in 1.7.2). It is not marked desktop-only.

### BRAT

You can install and update it with the BRAT plugin: in BRAT choose "Add beta plugin" and enter `Volland/eddie-doc`.

### Community plugin list

Eddie Doc has not been submitted to the community plugin list yet. It cannot be found by searching in Obsidian's Community plugins browser.

## Five-minute walkthrough

1. **Install and enable** the plugin as above.
2. **Put the files in the vault.** You need the `.adoc` you are reviewing and the annotated PDF. Both must be inside the vault. On a phone the PDF has to be in the vault; on desktop you can also pick a file from disk and Eddie copies it in.
3. **Open the `.adoc`.** If no other plugin handles AsciiDoc, Eddie opens `.adoc` and `.asciidoc` files in the source editor.
4. **Run the command "Eddie Doc: Open PDF review"** from the command palette. Pick the annotated PDF from the list (newest first). If a `.adoc` with the same name sits beside the PDF, Eddie offers it as the source; otherwise you choose one. For the first PDF of a document it becomes `rev-1` without further questions. You may be asked whose marks these are (an editor or site name); leave it empty to skip.
5. **Open the review panel** (ribbon icon, or "Eddie Doc: Show the review panel"); it lives in the right sidebar. Marks are listed under Open, Needs review, Unmatched and Resolved. With "Anchor annotations when mapping" on (the default), Eddie also writes `// eddie:<id>` comments into your `.adoc`; see [Anchors](#anchors).
6. **Work through the panel.** Select an annotation: the editor jumps to its source line, and the panel shows the editor's remark. Type a reply and press Ctrl/Cmd+Enter, or press Resolve.
7. **Apply simple edits.** For a struck-through passage, a replacement or an insertion, the panel offers buttons under "Apply to the source". Each is one undoable editor change.
8. **Handle Unmatched marks.** Run "Eddie Doc: Triage unmatched annotations" and walk through them, linking each to a line or skipping it.
9. **Next round.** When the next annotated PDF arrives, put it in the vault and run "Eddie Doc: Start new review round...". Resolved state, notes and replies carry across.
10. **Send something back.** Run "Eddie Doc: Export review report" for a Markdown report, or "Eddie Doc: Stamp reviewed PDF" to write the marks and your replies into a freshly built PDF.

## The review panel

The panel is called "Eddie review". Open it from the ribbon icon, the status bar (desktop), or the command "Eddie Doc: Show the review panel". It replaces what VS Code spreads over the sidebar tree, the Problems panel, comment threads and quick fixes.

On a narrow screen (any phone, or a pane narrower than about 520 px) it shows either the list or the selected thread, with a "All annotations" back button.

### Header

The header shows the file name, the round and the mapping (the round label and the editor's name, when you gave one), and how many mappings the document has. Three buttons:

- a switch button, shown when the document has more than one mapping
- a plus button that adds an annotated PDF
- a menu button with the less common actions: re-map, triage, apply all confident edits, start a new round, add PDFs to this mapping, merge mappings, edit round details, remove this mapping, export report, stamp reviewed PDF, extract annotations as AsciiDoc, anchor and remove anchors, open the review folder

### Groups and filters

Annotations are grouped into four groups:

| Group | What is in it |
| --- | --- |
| Open | Linked to a source line with confidence at or above the high-confidence threshold, not yet resolved |
| Needs review | Linked, but with lower confidence, or stale (see [Troubleshooting](#stale-marks)) |
| Unmatched | Eddie could not find a source line |
| Resolved | Marked done |

Above the list there is one chip per group, with a count. Click a chip to hide or show that group. A search box ("Filter...") filters the list by text, and two menus narrow it by kind of mark and by page. Filters are kept while the panel is open but are not remembered across restarts.

Each row shows the kind of mark, a short title (with the editor's query number first when the comment has one, like `[12]`), and a line such as `p4 · 2 replies`, with `no source match` or `stale` where they apply.

### The thread

Selecting a row opens the thread:

- The editor's mark is the first post, read-only. It comes from the PDF.
- Your replies sit under it. You can edit and delete replies that carry your name.
- The reply box keeps what you type if the panel refreshes. Ctrl/Cmd+Enter or the Reply button sends it.
- The first time you reply, Eddie asks for your name, because Obsidian cannot read a git identity. You can change it later in settings or with "Eddie Doc: Set your name for replies".

Selecting a row also reveals the source line in the editor. If you have already opened a PDF preview, it follows the selection.

### Action buttons

| Button | What it does |
| --- | --- |
| Resolve / Reopen | Mark the item done, or open again |
| Confirm match | Vouch for the link. Eddie then never re-searches it, and a stale flag is cleared |
| Reveal | Go to the source line |
| Preview PDF | Open the PDF at the annotation's page in a split pane |
| Re-link to cursor | Link the item to the line your cursor is on |
| Pick line... | Choose the line from a list |
| Re-map | Run matching again for this one item |

### Apply to the source

Where the kind of mark allows it, an "Apply to the source" row of buttons appears. The choices depend on the mark, for example delete the struck words, replace the marked text (with the editor's suggestion pre-filled), or insert text at a caret mark. A struck-through word is removed exactly, not the whole line.

Each action is one editor transaction, so Undo reverses it, and nothing is applied without you pressing the button. "Apply all confident edits" (in the menu and the command palette) lists every confident, non-overlapping edit and asks once before applying them all. If some edits overlap it refuses and asks you to apply them one at a time.

Eddie Doc never rewrites your prose on its own.

## The editor markup

In an `.adoc` editor that has a review, Eddie adds:

- a **line highlight** on every annotated line, with a different state for open, needs-review and resolved
- a **gutter badge** with the annotation's number; click it to select the annotation in the panel
- a **hover** over an annotated line showing the remark
- an **end-of-line marker** after the annotated line (turn off with "Show end-of-line markers")

All of this is display only. None of it is written into your file, and removing the plugin removes it. As you type, Eddie shifts the stored positions so the marks follow the text, and when you stop typing for about a second and a half it re-maps if the text actually changed.

Marks are numbered `#1`, `#2`, ... and the numbers never change once assigned.

Not implemented: the editor's remark and the thread are not shown inline in the editor as expandable blocks. Use the panel.

## Anchors

An anchor is a line comment such as

```asciidoc
// eddie:3f9a1c
```

placed directly above an annotated block. It binds the mark to that paragraph instead of to a line number, so it survives your rewrites, a `sed`, or a merge, and it is removed with the paragraph if you delete the paragraph. AsciiDoc strips `//` comments when rendering, so an anchor never reaches your output. Figures and tables need no anchor; they use the `[#id]` you already give them.

Anchoring happens when a PDF is mapped, if "Anchor annotations when mapping" is on (it is by default). That is the one moment your source still resembles what the editor read, so it is the best moment to bind marks.

You can anchor on demand with "Eddie Doc: Anchor annotations in source" (for mappings made with auto-anchor off). To take the anchors out, run "Eddie Doc: Remove source anchors".

If you want a mark to stay attached through heavy rewriting, leave auto-anchor on. If you have a script or an AI tool that edits your manuscript, tell it to keep the `// eddie:` lines. [`docs/MANUSCRIPT-CLAUDE.md`](MANUSCRIPT-CLAUDE.md) is a ready-made paragraph for that.

## Rounds and mappings

Editing is iterative, and one round often comes back from several people.

- A **round** (`rev-1`, `rev-2`, ...) is one pass over the manuscript.
- A **mapping** is one annotated PDF matched onto the source. A round holds as many mappings as it got PDFs. Each mapping is its own sidecar, so two editors' marks on the same paragraph never overwrite each other.

| You want to | Command |
| --- | --- |
| Map the first PDF | Open PDF review |
| Map a second editor's PDF for the round in progress | Add annotated PDF to current round... |
| Map the next round's PDF, carrying state forward | Start new review round... |
| Append further PDFs' marks to a mapping (one numbered list) | Add PDFs to this mapping... |
| Fold other mappings into this one | Merge mappings into this one... |
| See another round or editor's marks | Switch round / mapping |
| Label the round, date it, record who sent it | Edit round details... |
| Delete one mapping's sidecar | Remove this mapping... |

"Open PDF review" on a document that already has history asks which round the PDF belongs to, so it can do any of the above.

**Carrying state forward.** Annotation ids change with every PDF export, so Eddie reattaches your resolved state, notes and replies by content (kind, author, comment, marked text). When the previous round had several mappings, it carries from the one with the same origin (the same editor's earlier pass), falling back to the most recent one. A new round starts numbering again at `#1`.

**Adding PDFs to a mapping.** Use this when an editor sends the chapter again with more marks. Only marks that are new are added. You are asked whose marks each file holds. Several PDFs can be picked at once.

**Merging.** Every mark moves to the target mapping with what you did to it: resolved state, notes, replies, hand-made links and anchors. A remark both mappings hold is kept once, with both copies' state combined. The merged mappings' sidecars are then deleted; their PDFs and reports are left alone.

"Preview in PDF" always opens the PDF a mark actually came from.

## Where files live

### The review folder

By default everything Eddie writes goes in `Eddie Reviews/` at the root of your vault. The folder is visible on purpose: Obsidian does not index or sync folders whose names start with a dot, so a review kept in a dot-folder would not reach your phone. You can rename it in settings; it must stay inside the vault.

The manuscript's own folder is never used for review files. The only things Eddie writes into your `.adoc` are anchors and edits you apply yourself.

```text
<vault>/
├── manuscript/
│   ├── chapter-01.adoc
│   └── chapter-01.pdf                       the PDF you built, untouched
├── Annotated/
│   └── chapter-01.annotated.pdf             what the editor sent
└── Eddie Reviews/
    └── manuscript/                          mirrors the manuscript path
        └── chapter-01/                      one folder per source document
            ├── rev-1/
            │   ├── acme-copyedit.review.json   the mapping
            │   ├── acme-copyedit.review.md     exported report
            │   └── pdf/
            │       ├── acme-copyedit.pdf          copy of the annotated PDF
            │       └── chapter-01.reviewed.pdf    stamped output
            └── rev-2/
                ├── acme-copyedit.review.json
                └── beta-proofread.review.json
```

The pattern is `Eddie Reviews/<manuscript path>/<doc>/rev-N/<mapping>.review.json`. The mapping name comes from the PDF's file name, slugged; two PDFs that slug the same inside a round get `-2`, `-3` suffixes.

### PDFs are copied into the vault

In Obsidian, each annotated PDF is copied into the round's `pdf/` folder as it is mapped. This setting is always on. A PDF outside the vault cannot be read on mobile, and a round stays readable after you clear your downloads. On desktop, choosing "Choose a file from disk..." in the PDF picker reads the file and copies it to `Eddie Reviews/_imported/` first.

### Stamped PDFs and reports

By default both go in the round's folder. You can change this in settings to put the stamped PDF beside the source PDF, or the report beside the source file.

### Committing and syncing

The sidecars are the review. They are plain JSON, diff cleanly, and use paths relative to themselves. If the vault is in git, commit `Eddie Reviews/`. If you would rather not keep PDFs in git, ignore only the PDFs:

```gitignore
Eddie Reviews/**/pdf/
```

Do not ignore `*.review.json`; losing them loses which marks you have handled.

If you sync the vault with Obsidian Sync or another tool, `Eddie Reviews/` is a normal folder and is synced with everything else. The plugin watches the review folder. When a sync brings in a sidecar another device changed, Eddie re-reads it. If you had unsaved changes of your own at that moment, it merges rather than overwrites: replies and annotations that exist only in the other copy are added to yours, the other copy is kept beside the file as `*.conflict-<time>.txt`, and a notice tells you. Resolved flags are not merged (it cannot tell which side changed them), so yours stay. Still avoid working on one round on two devices at once.

Renaming or moving things in Obsidian is followed: rename a manuscript, a PDF, the review folder or a sidecar and the review stays attached and its recorded paths are rewritten.

### Using the same files in VS Code and the CLI

The sidecar is the same format (version 3) in the VS Code extension, the Obsidian plugin and the CLI. It is documented in [FORMAT.md](FORMAT.md), with a JSON Schema at [schema/review-v3.schema.json](../schema/review-v3.schema.json). The two hosts use different default folders (`.eddie` in VS Code, `Eddie Reviews` in Obsidian). To continue an Obsidian review in VS Code, set `eddieDoc.reviewFolder` to `Eddie Reviews` for that workspace. Going the other way, keep the review in a visible folder: Obsidian does not index dot-folders such as `.eddie`. Interop between the hosts is by design and covered by the shared core's tests, but it has not been tried with a real vault yet.

## AsciiDoc files in Obsidian

Obsidian does not know AsciiDoc, and only one plugin can own a file extension. Eddie handles this in two ways:

1. **Nobody else handles `.adoc`.** Eddie registers `.adoc` and `.asciidoc` and opens them in Obsidian's built-in editor in source mode. You see and edit the raw text. Nothing is rendered.
2. **Another plugin already handles `.adoc`.** Eddie leaves the extension alone and never takes the file from that plugin. When Eddie needs to show you the source (revealing an annotation, applying an edit), it opens the file in Obsidian's built-in editor in source mode, in its own tab, with the highlights, gutter badges and hover. The other plugin's view stays what it is. This is the pairing [AsciiDoc Live](https://github.com/koshlensky/asciidoc-live) describes for itself: its preview refreshes from edits made in the built-in editor in another pane, so you can keep its rendered preview in one pane and Eddie's marked-up source in the other. AsciiDoc Live's own view is a rendered preview with a plain text box for source, which cannot carry Eddie's markup; that is why Eddie opens its own tab instead of trying to draw on it. Other AsciiDoc plugins ([Asciidoctor editor](https://github.com/dzruyk/obsidian-asciidoc), [Asciidoc Reader](https://github.com/voidgrown/obsidian-asciidoc)) have not been tried.

The decision is made once, after all plugins have loaded, so Eddie does not take the extension from a plugin that loads later.

Setting "Open .adoc files with Eddie":

| Value | Behavior |
| --- | --- |
| Auto | Eddie claims `.adoc` and `.asciidoc` if no other plugin has |
| Never | Eddie claims nothing; it opens `.adoc` files in the built-in editor in its own tab when it needs to show them |

Changing it needs a plugin reload.

Rendering AsciiDoc is a non-goal. If you want a formatted preview, install another AsciiDoc plugin and set Eddie to Auto or Never as you prefer. AsciiDoc Live is desktop-only, so on a phone Eddie normally owns `.adoc` itself.

## Mobile

The plugin is not marked desktop-only and uses the same code on phones and tablets. It has been checked with Obsidian's mobile emulation, which exercises the layout and the platform checks but still runs on desktop, and not yet on a real device (see the status box).

What is expected to work on mobile: mapping a PDF that is in the vault, the review panel, replies, resolving, applying edits, re-mapping, triage, exporting a report, stamping, anchors.

Desktop only:

- choosing a PDF from outside the vault ("Choose a file from disk..."); on mobile the PDF must already be in the vault
- the semantic matching fallback (Ollama); its settings are hidden on mobile
- the status bar item

On a narrow screen the review panel shows the list or the thread, one at a time.

Open question: PDF parsing on phones runs in a Blob worker, with a main-thread fallback if the worker cannot start. Neither has been verified on a phone, and a roughly 300-page PDF may be slow or heavy on memory. Mapping, stamping and extraction show per-page progress, release each page as they go, and can be cancelled: click the progress notice, or run "Cancel the running operation".

## Commands

All commands appear in the command palette with the prefix "Eddie Doc: ". There are 32. A command that cannot do anything in the current state (no review loaded, no annotation selected, nothing to migrate) is not offered in the palette. The panel's reply box replaces the VS Code reply, edit, save, cancel and delete commands.

### Start and manage a review

| Command | What it does |
| --- | --- |
| Show the review panel | Open or reveal the panel |
| Open PDF review | Pick an annotated PDF and map it. If the document already has history, it asks which round |
| Start new review round... | Map a PDF as the next round, carrying state forward |
| Add annotated PDF to current round... | Map a second PDF for the round in progress, as its own mapping |
| Add PDFs to this mapping... | Append marks from further PDFs to this mapping |
| Merge mappings into this one... | Fold other mappings of the document into this one |
| Edit round details... | Set label, date, origin, reviewer, kind of review and kind of PDF |
| Remove this mapping... | Delete one mapping's sidecar. Manuscript and PDFs are untouched |
| Switch review | Switch to another document's review |
| Switch round / mapping | Show another round or another editor's marks |
| Re-map annotations | Run matching again against the current source, for every round of the document |
| Move reviews into review folder... | Relocate sidecars that sit beside the manuscript |
| Open review folder | Reveal this document's review folder |
| Import a PDF from outside the vault... | Desktop only. Copy a PDF into the vault, then offer to map it |
| Cancel the running operation | Stop mapping, stamping or extraction at its next page |

### Work through annotations

| Command | What it does |
| --- | --- |
| Next annotation / Previous annotation | Jump between annotated lines |
| Toggle resolved | Mark the selected item done or open |
| Reveal in source | Go to the selected item's line |
| Preview in PDF | Open the PDF at the item's page |
| Confirm match | Vouch for the current link |
| Re-link to current cursor line | Link the selected item to the line under your cursor |
| Reselect source line | Choose the line from a list |
| Re-map this annotation | Run matching again for the selected item |
| Triage unmatched annotations | Walk every unmatched item with a ranked shortlist of lines |
| Apply all confident edits | List and apply every confident, non-overlapping edit in one action |

Commands that act on "the selected item" need an annotation selected in the panel first. Right-click an annotated line in the editor for resolve, preview and the simple edits, and right-click a PDF or a mapped `.adoc` in the file explorer to map it or open its review.

### Output and anchors

| Command | What it does |
| --- | --- |
| Export review report | Write the active mapping as a Markdown report |
| Stamp reviewed PDF | Write marks and replies into a newly built PDF as real PDF annotations. The clean PDF is not changed |
| Extract annotations as AsciiDoc | Save a PDF's annotations as a new `.adoc` file, without mapping them |
| Anchor annotations in source | Write `// eddie:<id>` comments above annotated blocks |
| Remove source anchors | Remove those comments |

### You

| Command | What it does |
| --- | --- |
| Set your name for replies | Set the name shown on your replies |

## Settings

Open Settings, Community plugins, Eddie Doc. Defaults differ from VS Code in the review folder, and PDFs are always copied in.

| Setting | Default | Meaning |
| --- | --- | --- |
| Review folder | `Eddie Reviews` | Where mappings, reports and PDF copies are kept, relative to the vault. Keep it visible: Obsidian does not index or sync dot-folders. A value that would leave the vault falls back to the default |
| Copy annotated PDFs into the vault | On, cannot be turned off | A PDF outside the vault cannot be read on mobile, and a round stays readable after the download folder is cleared |
| Stamped PDFs | In the review folder | Where a reviewed PDF is written: in the review folder, or beside the source PDF |
| Reports | In the review folder | Where an exported report is written: in the review folder, or beside the source file |
| Match threshold | 0.5 | Minimum score for a mark to be linked to a source line |
| High-confidence threshold | 0.75 | Marks at or above this are Open; below it they need review |
| Character-trigram fallback | On | Rescue marks the word matcher could not place, using character overlap |
| Trigram threshold | 0.6 | Minimum similarity for that fallback |
| Use a local embedding model (desktop only) | Off | Rescue paraphrased marks through an Ollama server |
| Ollama URL (desktop only) | `http://localhost:11434` | Where the embedding server is |
| Embedding model (desktop only) | `embeddinggemma` | Which model to embed with |
| Semantic threshold (desktop only) | 0.62 | Minimum cosine similarity to accept a semantic link |
| Show resolved annotations | On | Keep resolved items visible in the panel and the editor |
| Show end-of-line markers | On | A small marker after each annotated line. Display only |
| Anchor annotations when mapping | On | Write `// eddie:<id>` comments above annotated paragraphs when a PDF is mapped |
| Open the first unanswered thread | Off | When the panel opens, select the first annotation you have not replied to |
| Your name on replies | empty | Shown beside your replies. Eddie asks once if empty |
| Preview with | Eddie's viewer | Eddie's viewer draws the page and the marked rectangle itself. Obsidian's own viewer opens the PDF at the page; in Obsidian 1.8.4 it does not draw the rectangle |
| Rectangle coordinates | PDF (origin bottom-left) | Only for Obsidian's viewer: try the other origin if the highlight lands in the wrong place |
| Open .adoc files with Eddie | Auto | Auto or Never; see [AsciiDoc files in Obsidian](#asciidoc-files-in-obsidian). Reload the plugin to apply |

Plugin settings are stored in the plugin's own `data.json`, not in the review folder.

## Troubleshooting

**The panel is empty.** "No review loaded" means no review is open for the current `.adoc`. Run "Open PDF review". If you have mapped before, open the `.adoc` once (Eddie loads its review on open), or run "Switch review". If the review folder was renamed after mapping, run "Move reviews into review folder...". The status bar (desktop) shows `Eddie · r<round> · <n> open` when a review is active.

**The `.adoc` opens as plain text, or in another plugin.** Eddie claims `.adoc` only if no other plugin has. If another AsciiDoc plugin is installed, the file opens there; Eddie opens its own source tab, beside it, when it needs to show you the file. To force the decision, set "Open .adoc files with Eddie" to Auto or Never and reload the plugin. If the file opens as plain text with no other plugin installed, check that the setting is Auto and that Eddie loaded without errors (Developer tools console, search for "Eddie Doc").

**The PDF preview shows the wrong page, or no rectangle.** By default Eddie draws the page and the rectangle itself. If you chose "Obsidian's PDF viewer", Eddie opens `file.pdf#page=N&rect=...`; checked on Obsidian 1.8.4 on macOS, that viewer lands on the right page but does not draw the rectangle. Switch "Preview with" back to Eddie's viewer. Eddie's viewer has been tried on desktop only, not on a phone.

**Preview says the PDF is missing.** The path recorded in the sidecar no longer exists. Put the PDF back, or map it again.

**Annotations are Unmatched.** The text under the mark could not be found above the threshold. Use "Triage unmatched annotations", or "Re-link to current cursor line". If many correct matches are rejected, lower the match threshold. Marks in a flattened PDF (printed to PDF, marks baked into the page) cannot be read at all; ask for an export with live annotations.

**Marks are stale.** A mark is stale when the text it was linked to has changed so that it no longer describes the source. The item keeps its last known position and shows in Needs review with "stale". Decide whether the remark still applies, then use Confirm match or Re-link to clear it.

**Marks in the editor do not move or look wrong after an edit.** Eddie shifts marks as you type and re-maps after you stop. If something looks off, run "Re-map annotations".

**A large PDF is slow on a phone.** PDF parsing is the heavy part. Close other panes, map one PDF at a time, and keep the app in the foreground until the progress notice finishes. If it still fails, map on desktop and let the sidecar sync to the phone.

**Sync conflicts.** If two devices wrote the same sidecar, Eddie merges the replies and new annotations and keeps the other copy as `*.conflict-<time>.txt` beside it. Resolved flags stay as on the device you were using. If the merge is not what you wanted, the kept copy is the other device's complete file; it is JSON.

## Privacy

Eddie Doc runs locally. It reads your `.adoc` and PDFs from the vault and writes its files back to the vault. It sends nothing anywhere and has no telemetry or analytics.

The one network feature is the optional semantic fallback, on desktop only and off by default. When you turn it on, Eddie sends source paragraphs and mark text to the Ollama URL you set (by default `http://localhost:11434`, your own machine) to compute embeddings, and to no other address. Embeddings are cached in the plugin folder.

## Limitations

- Phone testing so far is a hands-on try, not a measured one (see the status box).
- No AsciiDoc rendering.
- Comment threads are not shown inline in the editor; they live in the panel.
- Merging two devices' edits to one sidecar covers replies and added annotations, not resolved flags or edits to the same reply.
- Eddie does not apply edits automatically; applying is always an explicit button.
- Multi-file books (`include::`) are not resolved back to the included file.
- Ink and shape annotations carry only a position, not text.
- The semantic fallback is not available on mobile.
- Not in the community plugin list.

## FAQ

**Does Eddie rewrite my text?** Only when you press an "Apply to the source" button or run "Apply all confident edits", and then as an undoable change. Anchors are the other thing it writes; they are comments.

**Can I use it without the VS Code extension?** Yes. The Obsidian plugin is self-contained.

**Can I review in Obsidian and then continue in VS Code?** Yes, the format is shared. Point `eddieDoc.reviewFolder` at the same folder. See [Using the same files in VS Code and the CLI](#using-the-same-files-in-vs-code-and-the-cli).

**Do I need Ollama?** No. The semantic fallback is optional and off by default. The character-trigram fallback needs no setup.

**Does it work with the editor's PDF being flattened?** No. It reads real PDF annotations.

**Why is my review folder not a dot-folder like `.eddie`?** Obsidian does not index or sync dot-folders, so a review there would not reach your phone.

**What happens if I uninstall it?** The review folder stays. The anchors stay in your `.adoc` as comments and do not affect the rendered output. The VS Code extension, the CLI (`strip`), or the "Remove source anchors" command before uninstalling will take anchors out.

**Where do I report problems?** [GitHub issues](https://github.com/Volland/eddie-doc/issues). Include your Obsidian version, platform, plugin version, and, if mapping was wrong, a small `.adoc` and PDF or the relevant slice of the sidecar.

## Relation to the VS Code extension

Eddie Doc started as a VS Code extension. The matching, the PDF reading, the review model and the sidecar format live in a shared core, and each application, called a host, adds its own interface. The Obsidian plugin is one more host, next to the VS Code extension and the command-line tool.

| | VS Code extension | Obsidian plugin |
| --- | --- | --- |
| Surface | Activity-bar tree, inline decorations, Problems panel, gutter comment threads, lightbulb quick fixes | One review panel, editor line highlights, gutter badges, hover |
| Edits | Lightbulb quick fixes | "Apply to the source" buttons |
| Default review folder | `.eddie` | `Eddie Reviews` |
| PDFs copied into the review folder | Optional (off by default) | Always |
| Mobile | No | Yes (tried by hand on a phone; not measured) |
| Semantic fallback (Ollama) | Yes | Desktop only |
| Sidecar format | v3 | v3, same files |

See the [README](../README.md) for the VS Code extension and the command-line tool.
