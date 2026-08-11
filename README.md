# Eddie Doc — AsciiDoc PDF Review

You write a book in AsciiDoc, generate a PDF, and hand it to an editor. The
editor sends back an **annotated PDF** — highlights, strikethroughs, sticky-note
comments, rewrite requests. Reconciling those marks against the original `.adoc`
by hand is slow and error-prone.

**Eddie Doc** reads the annotated PDF, recovers the text under each annotation,
and maps every mark back to the exact line in your `.adoc` source. Annotations
become navigable, resolvable review items right in the editor.

## What it does

- **Extracts** highlights, strikethroughs, underlines, sticky-note comments, and
  caret/insert marks from the PDF (via `pdfjs`), including the comment body and
  author.
- **Maps** each annotation to a source line using fuzzy text matching that
  strips AsciiDoc syntax first, so a highlighted phrase lines up with your
  markup-laden source. Works with Unicode text (incl. Cyrillic).
- **Shows** annotations four ways:
  - an **activity-bar tree** grouped into *Open / Unmatched / Resolved*,
  - **inline decorations** on the affected source lines with a hover showing the
    comment and a *Mark resolved* link,
  - **Problems-panel diagnostics** for a flat, filterable overview,
  - **jump** commands to move between annotated lines.
- **Acts** via lightbulb **Quick Fixes** on an annotated line — all explicit and
  undoable, nothing runs automatically:
  - *Delete struck text* — **character-precise**: removes exactly the struck
    words (aligned back through AsciiDoc markup), not the whole line,
  - *Replace struck / highlighted text…* — opens an input prefilled with the
    editor's suggestion and applies it to the exact marked range,
  - *Insert text at mark…* — inserts at the caret's exact character offset,
  - *Insert editor note as comment* — pulls the editor's remark into the source
    as a removable `// ✎ …` AsciiDoc comment right above the line,
  - *Mark resolved / open*, plus a whole-line *Delete* fallback.
- **Tracks** resolution state and manual re-links in diffable sidecars, kept out
  of the manuscript folder in a review folder of their own (`.eddie/`).

The workflow is **navigate + review, edit by hand** — Eddie Doc never rewrites
your prose automatically. It points you at the right line and remembers what
you've handled.

It is built for a **real editing process**: several rounds of edits, each of
which can come back as more than one annotated PDF from more than one place. See
[Rounds and mappings](#rounds-and-mappings).

## Usage

1. Open the `.adoc` you're reviewing.
2. Run **Eddie Doc: Open PDF Review for AsciiDoc** (command palette, the
   editor-title comment icon, or the *Open PDF Review* button in the Eddie Doc
   sidebar). Pick the annotated PDF — a sibling `*.pdf` / `*.annotated.pdf` is
   offered by default.
3. Annotations appear in the **Eddie Doc** sidebar and as inline markers.
   - Click an item to jump to its source line.
   - Hover a marked line to read the comment and mark it resolved.
   - An annotation whose text couldn't be located lands under **Unmatched** —
     put your cursor on the right line and run **Re-link to Current Cursor Line**,
     or clear the whole pile at once with the **Triage** button on the
     *Unmatched* group: it walks each item with a pre-ranked shortlist of
     candidate lines so you link or skip them in a single keyboard pass.
4. Edit your `.adoc`, then run **Re-map Annotations** to re-check positions
   against the edited source. Resolution state is preserved across re-maps.
5. When the next round comes back, run **Start New Review Round** and pick the
   new PDF. Your resolved state, notes and replies carry across to it.

### Commands

| Command | What |
| --- | --- |
| `Eddie Doc: Open PDF Review for AsciiDoc` | Pick an annotated PDF and map it. Once the document has history, it asks which round the marks belong to |
| `Eddie Doc: Start New Review Round…` | Map a PDF as the next round (rev-N+1), carrying state forward |
| `Eddie Doc: Add Annotated PDF to Current Round…` | A second (third…) editor's PDF for the round already in progress |
| `Eddie Doc: Switch Round / Mapping` | Show a different round or a different editor's marks |
| `Eddie Doc: Edit Round Details…` | Set the round label, date, origin, reviewer, kind of review and kind of PDF |
| `Eddie Doc: Remove This Mapping…` | Delete one mapping's sidecar; the manuscript and PDF are untouched |
| `Eddie Doc: Re-map Annotations` | Re-run matching against current source, for every round of the document |
| `Eddie Doc: Next / Previous Annotation` | Jump between annotated lines |
| `Eddie Doc: Toggle Resolved` | Mark an item done / open |
| `Eddie Doc: Re-link to Current Cursor Line` | Override the match for an item |
| `Eddie Doc: Triage Unmatched Annotations` | Walk every unmatched item, each with a ranked shortlist of candidate lines, and link or skip in one pass |
| `Eddie Doc: Export Review Report` | Write the round as a Markdown report to send back to your editor |
| `Eddie Doc: Open Review Folder` | Reveal this document's folder in the review tree |
| `Eddie Doc: Move Reviews into Review Folder…` | Relocate sidecars that still sit beside the manuscript |

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `eddieDoc.reviewFolder` | `.eddie` | Folder holding all review files. Relative to the workspace root; empty string keeps the old layout (sidecar beside the `.adoc`). |
| `eddieDoc.importPdfs` | `false` | Copy each annotated PDF into its round's `pdf/` folder so the round is self-contained. |
| `eddieDoc.stampOutput` | `reviewFolder` | Where **Stamp Reviewed PDF** writes: the round's `pdf/` folder, or beside the clean render. |
| `eddieDoc.reportOutput` | `reviewFolder` | Where **Export Review Report** writes: the round's folder, or beside the `.adoc`. |
| `eddieDoc.matchThreshold` | `0.5` | Minimum similarity (0–1) to auto-link; below this an item is *Unmatched*. |
| `eddieDoc.highConfidence` | `0.75` | Score at/above which a link is trusted; below it the item lands in *Needs review*. |
| `eddieDoc.showResolved` | `true` | Show resolved items in the tree and as decorations. |
| `eddieDoc.expandThreads` | `false` | Open every unanswered thread as the document opens. Off keeps the prose readable — open one thread at a time from the gutter icon. |
| `eddieDoc.lexicalFallback` | `true` | Rescue unmatched items via built-in character-trigram similarity (no setup needed). |
| `eddieDoc.lexicalThreshold` | `0.6` | Minimum trigram-containment score for a lexical rescue. |
| `eddieDoc.semanticFallback` | `false` | Rescue unmatched items via a local embedding model served by Ollama. |
| `eddieDoc.ollamaUrl` / `eddieDoc.embedModel` / `eddieDoc.semanticThreshold` | — | Where and how the semantic fallback embeds. |

## Rounds and mappings

Editing is iterative. A chapter goes out, comes back marked up, gets rewritten,
goes out again — and a single round often comes back from **several places at
once**: a copy editor at the publisher, a technical reviewer, a proofreader.

Eddie Doc models exactly that, with two words:

- a **revision** (round) — `rev-1`, `rev-2`, … — is one pass over the manuscript;
- a **mapping** is one annotated PDF matched onto the source. A round holds as
  many mappings as it got PDFs.

Each mapping is one sidecar file with its own review state, so two editors'
marks on the same paragraph never overwrite each other. The sidebar shows one
mapping at a time; a **Rounds** group at the bottom of the tree lists the others,
and the status bar always says which one you're looking at (`chapter-01 ⇄ r2 ·
Acme Editorial`).

### Setting up a project

Nothing to set up: the defaults do the right thing. The first PDF you open
becomes `rev-1` with no questions asked, and every file Eddie Doc writes goes
under `.eddie/` at your workspace root. The next section is the full picture of
what lands where.

### Running a round

1. **First PDF for a chapter** — *Open PDF Review*. It becomes `rev-1`.
2. **Another editor's PDF for the same round** — *Add Annotated PDF to Current
   Round*. It joins `rev-1` as a second mapping; you're asked where it came from
   so the two are told apart in the sidebar.
3. **The next round** — *Start New Review Round*. It becomes `rev-2`, and your
   resolved state, notes and replies carry over automatically: annotation ids
   change with every PDF export, so Eddie Doc reattaches state by annotation
   *content* (kind, author, comment, marked text). Where the previous round had
   several mappings, it carries from the one with the same `origin` — the same
   editor's earlier pass — falling back to that round's most recent mapping.
4. **Moving between them** — click a row in the tree's **Rounds** group, or run
   *Switch Round / Mapping*.

*Open PDF Review* on a document that already has history asks which round the
PDF belongs to, so you can also use it for all three cases.

### Metadata each mapping keeps

*Edit Round Details* fills in what the files record about themselves — visible in
the tree tooltip, the report, and to any tool reading the sidecar:

| Field | What it's for |
| --- | --- |
| Round label / received date / note | Naming and dating the pass ("Copyedit, received 2026-07-02") |
| From (origin) | The publisher, agency or site the marks came from — also what carry-over matches on |
| Reviewer | The person, when different from the origin |
| Kind of review | `copyedit`, `proofread`, `developmental`, `technical`, `legal` |
| Kind of PDF | `annotated`, `proof`, `clean`, `stamped` — a round involves several PDFs of the same chapter and only an *annotated* one carries marks |

### Intermediate PDFs

Two settings decide whether generated and incoming PDFs land in the review
folder or beside the manuscript:

- `eddieDoc.importPdfs` (default off) — copy each annotated PDF into
  `.eddie/…/rev-N/pdf/` as it is mapped. Turn it on when PDFs arrive by email
  and live in a download folder that gets cleared: the round then stays readable
  (and previewable) forever. The sidecar records where the copy came from.
- `eddieDoc.stampOutput` (default `reviewFolder`) — **Stamp Reviewed PDF** writes
  `<name>.reviewed.pdf` into the round's `pdf/` folder rather than next to your
  clean render. The clean render is never modified either way, so the file you
  deliver cannot pick up review markup by accident.

### Coming from an earlier version

Sidecars already sitting next to your `.adoc` files keep working exactly as
before — they load as `rev-1` and are upgraded in place on the next write.
Nothing moves until you run **Move Reviews into Review Folder**, which shows you
every `from → to` before touching anything, rewrites each file at its new
location (so the relative paths inside stay correct) and leaves the manuscript
alone.

## File structure

Two rules govern everything below: **the manuscript folder only ever holds your
manuscript**, and **every review file says what it is**, so the structure is a
convenience rather than something you have to keep in sync.

### The review folder

```text
book/                                   ← your repository
├── manuscript/                         ← your deliverable. Eddie Doc never writes here
│   ├── chapter-01.adoc
│   ├── chapter-02.adoc
│   └── part-2/
│       └── chapter-07.adoc
│
├── .eddie/                             ← eddieDoc.reviewFolder (default ".eddie")
│   ├── manuscript/                     ← mirrors the manuscript tree exactly
│   │   ├── chapter-01/                 ← one folder per source document
│   │   │   ├── rev-1/                  ← round 1
│   │   │   │   ├── acme-copyedit.review.json    the mapping (see below)
│   │   │   │   ├── acme-copyedit.review.md      exported report
│   │   │   │   └── pdf/
│   │   │   │       ├── acme-copyedit.pdf        imported annotated PDF
│   │   │   │       └── chapter-01.reviewed.pdf  stamped output
│   │   │   └── rev-2/                  ← round 2
│   │   │       ├── acme-copyedit.review.json    same editor, next round
│   │   │       └── beta-proofread.review.json   second editor, same round
│   │   └── chapter-02/
│   │       └── rev-1/ …
│   └── manuscript/part-2/
│       └── chapter-07/
│           └── rev-1/ …
│
└── build/                              ← your asciidoctor-pdf output, untouched
    └── chapter-01.pdf
```

| Level | What it is | Named after |
| --- | --- | --- |
| `.eddie/` | Everything Eddie Doc produces | `eddieDoc.reviewFolder` |
| `.eddie/<path>/<stem>/` | One source document | its path under the workspace root, so two `chapter-01.adoc` in different folders never collide |
| `…/rev-N/` | One editing round | the round number, counted from 1 |
| `…/rev-N/<id>.review.json` | One mapping — one annotated PDF matched onto the source | the PDF's file name, slugged (`Acme Copyedit.annotated.pdf` → `acme-copyedit`) |
| `…/rev-N/<id>.review.md` | That mapping's exported report | its mapping |
| `…/rev-N/pdf/` | Imported annotated PDFs and stamped output | — |

Two PDFs whose names slug identically inside one round get `-2`, `-3` suffixes
rather than overwriting each other. Nothing is ever written outside the review
folder except by the commands that explicitly edit your source (*Anchor
Annotations in Source*, the Quick Fixes).

### What each file is for

| File | Written by | Life cycle |
| --- | --- | --- |
| `<id>.review.json` | Every review action | **The review.** Editor's marks, where each lands in the source, and your resolved state, notes and replies. Commit it. |
| `<id>.review.md` | *Export Review Report* | A snapshot to send back to that editor. Regenerate any time; safe to delete. |
| `pdf/<id>.pdf` | *Open PDF Review* with `eddieDoc.importPdfs` on | A copy of what the editor sent, kept so the round survives a cleared download folder. |
| `pdf/<name>.reviewed.pdf` | *Stamp Reviewed PDF* | A fresh render with the marks and replies written back in. Regenerated from source each time. |

### What to commit

**Commit `.eddie/`.** The sidecars *are* the review: they diff cleanly, every
path inside them is relative, and a clone on another machine works unchanged.
Losing them loses which marks you've handled.

If you'd rather not carry PDFs in git, ignore only those:

```gitignore
.eddie/**/pdf/
```

Reports are cheap to regenerate, so ignoring `.eddie/**/*.review.md` is also
reasonable. Never ignore `*.review.json`.

### Choosing a different layout

`eddieDoc.reviewFolder` takes a relative path (resolved against the workspace
root), an absolute path, or an empty string:

| Value | Result |
| --- | --- |
| `.eddie` *(default)* | `.eddie/…` at the workspace root, tree mirrored |
| `reviews` | Same, in a visible folder |
| `../book-reviews` | Beside the repository — for keeping reviews out of the manuscript repo entirely |
| `/Users/me/reviews` | An absolute location shared by several projects |
| `""` *(empty)* | **Legacy layout:** `<file>.review.json` beside each `.adoc`. Rounds after the first are disambiguated by name (`chapter-01.rev-2-beta.review.json`), since there is no folder to put them in. |

With no folder open (a single `.adoc` in a window), `.eddie/` is created next to
that file.

### Finding things without the folder structure

The layout is for humans. Tools don't need it: each sidecar records its own
`revision`, `mapping`, source path and PDF path, so a consumer reconstructs the
full history from the files alone.

```bash
# every mapping in the project, newest round last
ls .eddie/**/rev-*/*.review.json

# which source, round and editor a given file describes
jq '{source: .source.path, round: .revision.ordinal, from: .mapping.origin}' \
  .eddie/manuscript/chapter-01/rev-2/acme-copyedit.review.json
```

Moving a sidecar to another folder keeps it valid as long as the relative paths
inside it still resolve; Eddie Doc rewrites those for you when *Move Reviews into
Review Folder* relocates a file.

## How mapping works

PDF text-markup annotations carry *quadPoints* — per-line rectangles over the
marked text. Eddie Doc intersects those with the positioned text of each page to
recover the words under the mark (sticky notes, which have no anchored text, use
the nearest line to their icon). Both the recovered text and every source line
are normalized — AsciiDoc delimiters, roles, macros and inline markers stripped,
lowercased, punctuation removed — then compared with a blended Sørensen–Dice
(bigram) + token-overlap score over a sliding window of source lines. The best
span above the threshold wins.

Because it's fuzzy, mapping is robust to the source and PDF not being
character-identical, but it isn't infallible: low-confidence matches surface as
*Unmatched* for a one-click manual re-link rather than guessing.

Items the token matcher can't place get two rescue tiers before landing in
*Unmatched*, both marking their results for the *Needs review* group rather
than silently trusting them:

1. **Semantic** (opt-in): embed source paragraphs and the anchor with a local
   Ollama model and link by cosine similarity — catches paraphrased remarks.
   Embeddings are batched and cached, so re-maps don't re-embed.
2. **Lexical** (on by default, zero setup): character-trigram similarity
   against source paragraphs — catches inflected, hyphen-mangled, or typo'd
   wording that token overlap misses.

## Reports

**Export Review Report** writes a Markdown report for the active mapping —
grouped into Open / Needs review / Unmatched / Resolved with comments, line
numbers and notes — ready to send back to that editor. It goes to the round's
folder (`.eddie/…/rev-2/acme-copyedit.review.md`) unless `eddieDoc.reportOutput`
says otherwise, and the sidecar records it as an artifact. Also available
headless via `node dist/cli.js book.pdf book.adoc --report`.

With several editors on one round, export once per mapping: each report covers
one editor's marks and your answers to them, which is what that editor needs
back.

## Replying, and keeping annotations across a rebuild

Asciidoctor has no concept of PDF annotations, so every rebuild starts from a
blank page and the editor's marks are gone. Two features close that loop.

### Reply threads

Each annotation appears as a threaded comment in the gutter beside the line it
maps to: the editor's mark is the root post, your replies sit underneath. The
editor's mark is read-only — it came from the PDF — while replies are yours to
edit and delete. Replies live in the sidecar under `state.replies`, so they are
committed with the manuscript and survive re-mapping. Set `eddieDoc.authorName`
to control the name on them (it defaults to your git `user.name`).

### Stamping a freshly generated PDF

**Eddie Doc: Stamp Reviewed PDF** — or `eddie-doc stamp` in a build script —
writes the marks and your replies into a newly rendered PDF as real PDF
annotations, producing `<name>.reviewed.pdf` beside the clean render. The clean
render is never modified, so the file you deliver can't accidentally ship with
review markup on it.

```bash
asciidoctor-pdf -o build/ch04.pdf src/ch04.adoc

# one round, one editor
node dist/cli.js stamp build/ch04.pdf \
  --review .eddie/src/ch04/rev-2/acme-copyedit.review.json

# every editor's marks from the current round, on one PDF
node dist/cli.js stamp build/ch04.pdf \
  --review .eddie/src/ch04/rev-2/acme-copyedit.review.json \
  --review .eddie/src/ch04/rev-2/beta-proofread.review.json
```

`stamp` takes any number of `--review` sidecars and writes them all into one
PDF, so a round that came back from several places goes back out as a single
marked-up file. Each sidecar names its own source, so the CLI finds the right
`.adoc` wherever the sidecar lives.

Positions are **re-derived from the current source text**, never from the stored
geometry — that described a PDF which no longer exists. Repagination, a font
change or a theme tweak are therefore irrelevant. Where the words the editor
marked have since been rewritten, the mark degrades to the paragraph and says so
in its comment rather than silently claiming she marked text she never saw.
Anything that can't be placed is reported, never guessed at.

### Durable source anchors

Live position tracking follows your edits inside VS Code, but a `sed`, a git
merge or an agent rewriting a file bypasses it — and afterwards, matching the
editor's (now outdated) PDF text against rewritten prose produces confident
wrong answers.

**Eddie Doc: Anchor Annotations in Source** writes invisible `// eddie:<id>`
markers above annotated blocks. A marker lives *in* the text, so it moves with
the paragraph no matter who edits it; delete the paragraph and the marker goes
with it, which is the correct outcome. Asciidoctor strips `//` comments before
rendering, so a marker can never reach the PDF or the file you deliver — the
marked and unmarked sources render byte-identical text.

Anchoring is opt-in per chapter and never happens automatically; **Remove Source
Anchors** (or `eddie-doc strip`) takes them out again. Figures and tables need
no marker: they anchor to the `[#id]` you already give them.

## The review sidecar (`.review.json`)

The sidecar is a **portable, versioned, tool-agnostic** file you can commit and
diff. One file describes one mapping: which round it belongs to, whose marks
they are, what kind of PDF they came from, and — per item — the PDF-derived
annotation, the matcher's mapping and your review state, in separate blocks.
Paths are relative to the sidecar and content hashes let a consumer detect stale
inputs. It's specified as a small standard so a CLI, CI gate, or another editor
can read it:

- **Spec:** [docs/FORMAT.md](docs/FORMAT.md)
- **JSON Schema:** [schema/review-v3.schema.json](schema/review-v3.schema.json)

```bash
# validate every mapping in the project against the schema
npx ajv-cli validate --spec=draft2020 --strict=false \
  -s schema/review-v3.schema.json -d ".eddie/**/*.review.json"
```

Because each file names its own revision and mapping, the review history
reconstructs from the files alone — there is no index to keep in sync, and a
sidecar stays readable if you move it.

Version 1 and 2 sidecars are migrated transparently on first write; a v2 file
becomes the sole mapping of `rev-1`.

## Development

```bash
npm install
npm run build          # bundle with esbuild -> dist/
npm run typecheck      # tsc --noEmit
npm test               # mocha unit tests
npm run bench          # matching-quality gate against sample/*.golden.json

# Prove extraction + mapping outside VS Code:
node dist/cli.js <annotated.pdf> <source.adoc> [--json|--report] [--lexical]

# Regenerate the sample fixture (needs asciidoctor-pdf + python3 PyMuPDF):
asciidoctor-pdf -o sample/chapter-01.pdf sample/chapter-01.adoc
python3 sample/annotate.py sample/chapter-01.pdf sample/chapter-01.annotated.pdf
```

Press **F5** (Run Extension) to launch an Extension Development Host with the
`sample/` folder open.

### Layout

```text
src/
  pdf/extract.ts        annotation + positioned-text extraction (pdfjs)
  matching/normalize.ts AsciiDoc-aware text normalization
  matching/fuzzyMatch.ts sliding-window similarity → source line span
  matching/align.ts     stripped text → exact raw char offsets (precise edits)
  matching/mapper.ts    annotations + source → review items (+ round carry-over)
  matching/lexical.ts   char-trigram rescue tier for unmatched items
  matching/semantic.ts  optional Ollama-embedding rescue tier (batched, cached)
  model/types.ts        domain model (revisions, mappings, items)
  model/layout.ts       where review artifacts live (the .eddie tree)
  model/format.ts       the portable on-disk sidecar standard (v3, reads v1/v2)
  model/store.ts        mappings per document + diffable sidecar persistence
  model/report.ts       Markdown review-report renderer
  benchmark/            golden-corpus matching-quality gate (npm run bench)
  ui/treeProvider.ts    activity-bar tree
  ui/decorations.ts     inline line markers + hovers
  ui/diagnostics.ts     Problems-panel entries
  ui/codeActions.ts     lightbulb Quick Fixes
  ui/precise.ts         resolve exact edit ranges/positions in the document
  util.ts               AsciiDoc document detection
  extension.ts          activation, commands, wiring
  cli.ts                standalone extraction/mapping harness
  test/                 mocha unit tests (normalize / fuzzy / mapper)
```

## Roadmap

- ~~One-click Quick Fixes that apply strikethrough deletions / replacement
  text.~~ ✅ *shipped — see the lightbulb on any annotated line.*
- ~~Precise character-level (not line-level) replacement application.~~ ✅
  *shipped — strikeouts delete exact words, replace/insert hit exact offsets.*
- ~~Several rounds of edits, each with several annotated PDFs from different
  editors, stored outside the manuscript folder.~~ ✅ *shipped — see
  [Rounds and mappings](#rounds-and-mappings).*
- Multi-file books (resolve `include::` back to the right chapter file).
- Open the PDF page beside the source for side-by-side review.
- Ink / shape annotations (positional only).

## License

MIT
