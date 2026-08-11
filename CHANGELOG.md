# Changelog

All notable changes to **Eddie Doc — AsciiDoc PDF Review** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Marks stop drifting. Re-matching an established link could only ever degrade it
— it compares the editor's original PDF wording against prose that has since
been rewritten — and it ran on every save. Links are now *maintained* rather
than recomputed, and bound to the text itself the moment a PDF is mapped.

### Fixed
- **Rewriting the document silently moved the marks.** The save-time re-map
  discarded the position it already had (kept correct by live tracking, which
  follows your real edits) and re-derived it by matching the editor's original
  wording against the current text. Once the marked sentence is rewritten the
  strongest remaining candidate is some *other* paragraph that still shares its
  vocabulary — a confident wrong answer, which then overwrote the right one.
  An established link is now defended, not recomputed: a hand-picked line, a
  marker, or a link you vouched for is never re-searched, and an automatic link
  only *moves* for a match at least as good as the one it would replace.
- **Confirming a match did nothing that lasted.** `confirmed` was the one field a
  re-map did not carry forward, so every save quietly un-vouched the item and
  then re-matched it — discarding the only signal a human had given it.
- **A lost anchor fell through to guessing.** When a marker, block id and
  fingerprint all failed to resolve, the item was handed to the fuzzy matcher —
  precisely the case where it is least trustworthy. It now holds its place and
  is flagged instead.
- **Editing shook the page.** Typing in a mapped `.adoc` rebuilt the UI far more
  often than it needed to, and the rebuilds were visible as the text jumping
  under the cursor.
  - The save-time re-map ran on every save. With autosave on, "on save" means
    *every second while you type* — and each pass re-ran the matcher over every
    round, rewrote every sidecar and refreshed the whole UI. It is now debounced
    to a pause in typing, and skipped entirely when the text is byte-for-byte
    what those positions were already matched against.
  - `remapAll` fired a change event **per round**, so a document with three
    mappings rebuilt the tree, the decorations and the comment threads three
    times per save. Worse, it made each round active in turn as it went, so the
    UI rendered every round on the way past before settling back. One event per
    document now, and the round on screen stays on screen.
  - Markers and problems were re-applied on every keystroke. An end-of-line
    marker takes up room in the line, so re-applying it mid-word re-wraps the
    paragraph being typed into. Redraws now settle 200 ms after the last
    keystroke; anchor tracking itself still happens per keystroke, as it must.
- **Replies could not be typed.** Clicking into a thread's reply box reflowed
  everything and threw the box away. Three things were tearing the widget down:
  every refresh disposed and recreated all threads (a disposed thread takes its
  popup, focus, typed text and expanded state with it), focusing the box fires an
  active-editor change that triggered exactly that refresh, and keystrokes in the
  box could be read as edits to the manuscript — shifting every annotation anchor
  under the cursor. Threads are now reconciled in place: only fields that
  actually differ are written, and the disclosure state belongs to the user after
  creation. Refreshes are skipped when focus merely leaves the text editors, and
  only real files on disk count as the manuscript, so a reply box, a diff side or
  a git buffer can no longer masquerade as the `.adoc`.

### Added
- **The editor's query number leads every label.** Copyeditors number their
  queries — `[12]`, `[C7]`, `[AU 3]` — and then discuss them by number, so that
  number is how a remark is addressed. It can sit anywhere in the comment, and
  every label here is length-capped, which made a trailing `[12]` the first
  casualty of truncation. It is now lifted to the front of the tree row, the
  inline marker, the hover, the comment thread header and body, the Problems
  entry and the report, and removed from the prose beside it so it is never
  printed twice. The pattern is deliberately narrow — it must contain a digit and
  stay short — so a comment quoting `[source,ruby]` or `[#anchor]` never gets
  markup promoted to a heading. The sidecar still stores the comment exactly as
  the editor wrote it.
- **Anchoring on import** (`eddieDoc.autoAnchor`, on by default). Invisible
  `// eddie:<id>` markers are written into the source as soon as a PDF is
  mapped, because import is the one moment the source still resembles what the
  editor read — the only moment matching can be trusted. From then on a mark
  resolves an identity that travels with its paragraph through any rewrite,
  `sed`, merge or agent pass. Applied as one undoable edit and saved at once (a
  sidecar naming markers that aren't on disk would be worse than no anchors); if
  you had unsaved work the markers are left dirty for you to save. Asciidoctor
  strips `//` comments, so they can never reach a rendered PDF.
- **Stale marks.** When nothing holds a link any more, the item keeps its last
  known place and is marked `stale`: routed to *Needs review*, labelled on the
  row, explained in the tooltip and hover, and counted in a warning when it
  happens. *Confirm Match* or *Re-link* clears it. Nothing relocates quietly.
- `eddieDoc.inlineMarkers` (default on) — turn off the `✎ <kind>` label at the
  end of each annotated line. It occupies room in the line, so in wrapped prose
  the paragraph re-wraps when a marker appears or changes width. Off keeps the
  line highlight, the overview-ruler mark and the hover.

### Changed
- **Comment threads start collapsed.** Every unanswered mark used to open its
  thread as the document opened, on the theory that the work still to do should
  be what you see. At one mark per chapter that reads well; at thirty it buries
  the prose in boxes, and — with word wrap on, as prose usually is — clicking any
  one of them re-lays out the page under the cursor, so the click misses the
  reply box. The gutter icon, the end-of-line marker and the tree already say
  where the work is. `eddieDoc.expandThreads` restores the old behaviour.
- Editing a reply happens in the thread itself, with *Save* and *Cancel*, instead
  of in a modal input box. A reply is read in context, so it is rewritten in
  context; emptying the box restores the previous text rather than saving a blank
  reply, since deleting is its own explicit action.

## [1.1.0] — 2026-08-09

Fits the real editing process. A manuscript goes through several rounds of
edits, and one round often comes back as several annotated PDFs from several
places at once — the model of "one `.adoc`, one sidecar, one PDF" could not hold
any of that, and it put its files in the folder authors ship. Reviews are now
rounds of mappings, stored outside the manuscript.

Closes the review loop. Annotations used to be lost the moment the PDF was
rebuilt — Asciidoctor has no concept of them — and there was nowhere to answer
the editor. Now the review survives a rebuild, and replies are first-class.

### Added
- **Revisions and mappings.** A document's review is now a set of *revisions*
  (`rev-1`, `rev-2`, …), each holding one or more *mappings* — one per annotated
  PDF. Two editors' marks on the same round are separate files with separate
  review state, so neither overwrites the other. *Start New Review Round* and
  *Add Annotated PDF to Current Round* are the two entry points; *Open PDF
  Review* asks which round a PDF belongs to once a document has history.
- **A review folder** — `eddieDoc.reviewFolder`, default `.eddie` at the
  workspace root, with subfolders mirroring the manuscript tree. Mappings,
  metadata, reports and intermediate PDFs live there instead of beside the
  `.adoc`, so the folder an author delivers stays clean. Set it to an empty
  string to keep the old layout.
- **Round and mapping metadata**, editable with *Edit Round Details*: round
  label, received date and note; the origin (publisher, agency, site), reviewer
  and kind of review (`copyedit`, `proofread`, `developmental`, `technical`,
  `legal`); and the kind of PDF mapped (`annotated`, `proof`, `clean`,
  `stamped`) — a round involves several PDFs of one chapter and only an
  annotated one carries marks. Sidecars also record the artifacts they produced
  (reports, stamped PDFs).
- **Round switching in the UI**: a *Rounds* group at the foot of the tree lists
  every mapping with its progress and switches on click, *Switch Round /
  Mapping* does the same from the palette, and the status bar and tree header
  now name the round on screen (`chapter-01 ⇄ r2 · Acme Editorial`).
- `eddieDoc.importPdfs` copies each annotated PDF into its round's `pdf/` folder
  so a round stays readable after the download folder it arrived in is cleared;
  `eddieDoc.stampOutput` and `eddieDoc.reportOutput` decide whether stamped PDFs
  and exported reports go to the review folder or beside the source.
- *Move Reviews into Review Folder* relocates sidecars still sitting beside a
  manuscript, showing every `from → to` first and rewriting each file at its new
  location so the relative paths inside stay correct.
- **Review format version 3**: every sidecar now records its own `revision`,
  `mapping`, `pdf.role` and `artifacts`, so a review's history reconstructs from
  the files alone with no index to keep in sync. Items are byte-for-byte
  unchanged from v2. Spec: [docs/FORMAT.md](docs/FORMAT.md); schema:
  [schema/review-v3.schema.json](schema/review-v3.schema.json).
- **Stamp the review onto a fresh render** — `eddie-doc stamp` (and
  *Eddie Doc: Stamp Reviewed PDF*) writes the editor's marks and your replies
  into a newly generated PDF as real PDF annotations, producing
  `<name>.reviewed.pdf` beside the untouched clean render. Positions are
  re-derived from the *current* source text, so repagination, font changes and
  rewrites don't matter. Every annotation carries an explicit appearance stream
  — without one, Preview.app draws nothing at all.
- **Reply threads** — annotations are now threaded comments in the editor
  gutter, via VS Code's native Comments API. Replies persist in the sidecar
  (`state.replies`) and are written into the stamped PDF as `/IRT` threads,
  which Acrobat renders as a conversation. `eddieDoc.authorName` sets the name
  on your replies (defaults to your git `user.name`).
- **Durable source anchors** — *Eddie Doc: Anchor Annotations in Source* writes
  invisible `// eddie:<id>` markers above annotated blocks and records them in
  `state`/`anchor`. A marker travels with the text, so an annotation stays on
  its paragraph even when the prose is rewritten outside the editor, where live
  position tracking cannot follow. Asciidoctor strips `//` comments before
  rendering: verified against a real 31-page chapter, the marked and unmarked
  sources produce byte-identical rendered text and the same named destinations.
  Anchoring is opt-in per chapter and never happens automatically; `strip`
  removes the markers again.
- `match.method` gained the deterministic tiers `marker`, `blockId` and
  `fingerprint`. These resolve an identity recorded in the source rather than
  measuring similarity, so they always win over `fuzzy`/`semantic`/`lexical`.
- CLI verbs: `map` (the previous behaviour, still the default), `stamp`,
  `anchor`, `strip`. `scripts/vendor-cli.sh` copies the built CLI — and the
  pdfjs worker it needs beside it — into a manuscript repo.

### Fixed
- **Input fingerprints were silently blank.** pdfjs *transfers* the array it is
  handed to its worker, detaching the caller's buffer, so hashing the same array
  afterwards hashed zero bytes and recorded `e3b0c442…` — the SHA-256 of nothing
  — as the PDF's digest. Staleness detection was dead for every sidecar written
  that way. The extractor now hands pdfjs a copy, the store fingerprints before
  extracting, and the zero-byte digest is ignored on read so existing sidecars
  recover instead of reporting as permanently stale.
- **Annotations at the same spot were dropped.** Item ids derive from page plus
  rounded geometry, which is not unique: two marks on one paragraph collided and
  the later one was discarded. Colliding ids are now suffixed instead. A real
  chapter lost 9 of 40 annotations to this on re-import.
- `--json` output could be corrupted by pdfjs's import-time polyfill warnings,
  which went to stdout. CLI results now go to stdout and all diagnostics to
  stderr, so the output is safe to pipe.

## [0.1.11] — 2026-08-03
- Release tooling: the producer-sync hook logs to stderr so the version bump's
  output can no longer corrupt packaging.

## [0.1.10] — 2026-08-03

Keeps the source ⇄ PDF ⇄ sidecar triangle explicit and safe: every chapter
keeps its own `<file>.review.json` bound to its own PDF, and nothing rebinds
silently.

### Added
- **Status-bar pair indicator** — always shows the active `source ⇄ PDF` pair
  (with a warning marker when the recorded PDF is missing on disk); click it to
  switch between loaded reviews.
- The sidebar header now shows the full pair (`chapter.adoc ⇄ chapter.pdf`),
  not just the source name.
- **Re-bind guard** — opening a different PDF for a source that already has a
  review asks before replacing it (state still carries over by content).

### Changed
- The sidecar producer version is now rewritten from package.json by an
  `npm version` lifecycle hook, so it can no longer drift between releases.

## [0.1.9] — 2026-08-03

Fixes driven by the first real-world publisher review round (a Manning
chapter PDF): 26 extracted "annotations" became 17 real ones, and 13–16 of 17
now map (vs 8 of 26 before).

### Fixed
- **Hyperlinks are no longer review items** — `Link` (and `Widget`) PDF
  annotations, e.g. asciidoctor-pdf cross-references, were extracted as junk
  "Note" items with no comment. A typical chapter carried 9 of them.
- **Running headers/footers no longer pollute anchors** — repeated page
  furniture ("22 Memory Systems for AI Agents", bare page numbers) is detected
  across pages and stripped before anchoring, so sticky notes near the page
  edge anchor to real prose instead of the title line.

### Added
- **Wrong-pair guard** — picking a PDF whose name matches a *different*
  workspace `.adoc` (e.g. CH03 PDF while CH02.adoc is open) now offers to bind
  the review to the matching source; after mapping, a mostly-unmatched result
  (< 40 %) warns that the PDF may belong to another file.
- Opening a review now brings the reviewed `.adoc` into the editor, so the
  sidebar, decorations and preview always show the session just mapped.

## [0.1.8] — 2026-08-02

### Added
- **Matching-quality benchmark** — `npm run bench` runs the real extraction +
  mapping pipeline over hand-verified golden corpora (`sample/*.golden.json`)
  and gates on the result, so matcher changes are measured, not eyeballed.
- **Export Review Report** — a command (and `dist/cli.js … --report`) that
  renders the session as a Markdown report (`<file>.review.md`) grouped into
  Open / Needs review / Unmatched / Resolved — the artifact you send back to
  your editor, with a staleness warning when inputs changed since mapping.
- **Second-round carry-over** — opening a re-exported PDF (which re-keys every
  annotation id) now carries resolved state, notes and manual links over by
  content fingerprint, so a new review round doesn't reset your progress.
- **Lexical fallback tier** (`eddieDoc.lexicalFallback`, on by default) —
  unmatched annotations get a second chance via character-trigram similarity
  against source paragraphs: catches inflected/typo'd wording with zero setup,
  no Ollama required. Tunable via `eddieDoc.lexicalThreshold`.

### Changed
- The semantic (Ollama) fallback now batches embeddings through `/api/embed`
  (with a legacy per-input fallback) and memoizes vectors in a persistent
  content-addressed cache, making re-maps near-instant instead of one HTTP
  round-trip per paragraph.

### Fixed
- Sticky notes parked in the page margin could anchor to a line in the wrong
  paragraph: nearest-line search now measures distance to each text run's
  rectangle (vertically weighted) instead of its centre. Caught by the new
  benchmark.

## [0.1.6] — 2026-07-12

### Added
- **Eddie Doc Review Format v2** — the `<file>.review.json` sidecar is now a
  portable, versioned, schema-validated standard: paths relative to the sidecar,
  SHA-256 content fingerprints for staleness detection, and each item split into
  `annotation` / `match` / `state`. See [docs/FORMAT.md](docs/FORMAT.md) and the
  [JSON Schema](schema/review-v2.schema.json).
- Project website with a plugin intro and the format spec, published via GitHub
  Pages at <https://volland.github.io/eddie-doc/>.

### Changed
- New logo — a cat whose muzzle is a fountain-pen nib — across the activity-bar
  icon, Marketplace icon, and website.
- Version-1 sidecars are migrated to v2 transparently on first write; no user
  action required.

## [0.1.5] — 2026-07-11
- Matching improvements and reliability fixes.

## [0.1.4] — 2026-07-11
- Added the PDF page preview webview.

## [0.1.3] — 2026-07-03
- Matching improvements.

## [0.1.0] — 2026-07-03
- Initial release: extract PDF annotations, fuzzy-map them to AsciiDoc source,
  and review them as tree items, inline decorations, and diagnostics.
