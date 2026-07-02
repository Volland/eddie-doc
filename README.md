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
- **Tracks** resolution state and manual re-links in a diffable sidecar,
  `<file>.review.json`, next to your `.adoc`.

The workflow is **navigate + review, edit by hand** — Eddie Doc never rewrites
your prose automatically. It points you at the right line and remembers what
you've handled.

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
     put your cursor on the right line and run **Re-link to Current Cursor Line**.
4. Edit your `.adoc`, then run **Re-map Annotations** to re-check positions
   against the edited source. Resolution state is preserved across re-maps.

### Commands

| Command | What |
| --- | --- |
| `Eddie Doc: Open PDF Review for AsciiDoc` | Pick an annotated PDF and map it |
| `Eddie Doc: Re-map Annotations` | Re-run matching against current source |
| `Eddie Doc: Next / Previous Annotation` | Jump between annotated lines |
| `Eddie Doc: Toggle Resolved` | Mark an item done / open |
| `Eddie Doc: Re-link to Current Cursor Line` | Override the match for an item |

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `eddieDoc.matchThreshold` | `0.55` | Minimum similarity (0–1) to auto-link; below this an item is *Unmatched*. |
| `eddieDoc.showResolved` | `true` | Show resolved items in the tree and as decorations. |

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

## Development

```bash
npm install
npm run build          # bundle with esbuild -> dist/
npm run typecheck      # tsc --noEmit
npm test               # mocha: normalize / fuzzyMatch / mapper

# Prove extraction + mapping outside VS Code:
node dist/cli.js <annotated.pdf> <source.adoc>

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
  matching/mapper.ts    annotations + source → review items
  model/types.ts        domain model
  model/store.ts        sessions + diffable sidecar persistence
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
- Multi-file books (resolve `include::` back to the right chapter file).
- Open the PDF page beside the source for side-by-side review.
- Ink / shape annotations (positional only).

## License

MIT
