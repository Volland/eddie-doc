# Obsidian mobile spike — results

**Status: desktop answered, phones not run.** The plan was to settle the open questions on real devices before relying on them. Desktop Obsidian (macOS, 1.8.4 and 1.13.7) has now been driven end to end by `npm run e2e:obsidian`, which answered the desktop half of several rows below. No phone or tablet has been tried, so every mobile question is still open and there are no mobile measurements.

The plugin was built assuming the answers it hopes for and failing soft where it can. This file records what was assumed, what was checked without a device, and what a device run must settle. When the spike is run, fill in the table and change the defaults named in the last column.

## What was checked without a device

| Question | Check | Result |
| --- | --- | --- |
| Does the pdfjs browser build, with the worker embedded as text, extract annotations correctly? | `npm run verify:obsidian-engine` runs it under Node, where `Worker` does not exist, so the main-thread fallback runs | Passes: 5 of 5 annotations on 5 pages, identical to the Node engine |
| Does the bundle contain Node-only code? | Build assertion in `esbuild.js` scans the output | None found |
| Does the plugin load, register its commands and view, map a PDF and reload it with only vault-relative paths? | `npm run smoke:obsidian`, against a stub `obsidian` module and an in-memory vault that, like Obsidian's, refuses to write into a missing folder | Passes |

## What the desktop runs established (2026-10-05)

| Question | Answer | Where |
| --- | --- | --- |
| Does the plugin load, register views and commands, and read its manifest in a real Obsidian? | Yes on 1.8.4 and 1.13.7 | `e2e-obsidian.cjs` §1 |
| Is the `viewRegistry.typeByExtension` shape what `holderOf` reads? | Yes on both; `adoc` maps to `markdown` once claimed, and to the other plugin's view type (`adoc` for AsciiDoc Live) when held | §1, pairing |
| Does `new Worker(blobUrl)` run pdfjs's worker? | Yes on desktop, both versions; the main-thread fallback was not needed | §1, §3 |
| Do all 5 annotations of the sample map through the real pickers? | Yes | §3 |
| Does `#page=N` open the right page in the built-in viewer? | Yes (page 3 of 5) | §5 |
| Does the built-in viewer draw `&rect=`? | **No**, on 1.8.4. Not checked on 1.13.7's viewer visually | §5, screenshot review |
| Does Eddie's own viewer draw the page and place the marker? | Yes: painted canvas, marker inside the page | §5 |
| Does Obsidian accept a Markdown view for a file whose extension AsciiDoc Live registered, and does its preview follow edits there? | Yes on both | pairing |
| Is unload clean (views unregistered, claim released, commands gone) and re-enable fine? | Yes | §9 |
| Does a sidecar written from outside, and a rename of the manuscript or review folder, reach the plugin? | Yes | §7 |

Also found: a view field named `titleEl` overwrote Obsidian's own and made the view fail to open (fixed; guarded by `viewFields.test.ts`); a selection made outside the panel did not show its thread in the narrow layout (fixed); and Obsidian 1.13.7 shows a "trust the author of this vault" prompt on first open, after which it also leaves a Settings window open that takes the active-window role from the main one.

## What a device run must settle

| # | Question | Assumed | Why it matters | If the assumption fails |
| --- | --- | --- | --- | --- |
| 1 | Does `new Worker(blobUrl)` run pdfjs's worker on iOS, Android and desktop? | Yes on desktop, unknown on phones | Otherwise parsing runs on the main thread and may freeze the UI | Handled by the main-thread fallback in `useObsidianPdfEngine`, which also triggers if the worker reports an error after starting; record which mode each device uses |
| 2 | Does the main-thread fallback finish a ~300-page PDF without a crash or a long freeze? | Yes | Full mobile parity depends on it | Extraction already reports per-page progress, frees each page, yields on a time budget and can be cancelled; if it still fails, turn off map/stamp on that platform by capability flag |
| 3 | Time and memory to map a ~300-page, ~200-annotation PDF | Under about two minutes | Decides whether mobile mapping is usable | As above |
| 4 | Does Obsidian's built-in PDF viewer honour `#page=N`? | Yes | The preview's minimum behaviour | Fall back to opening the PDF at page 1 and telling the user the page |
| 5 | Does it honour `&rect=l,b,r,t` (PDF user space)? In which coordinates, and on rotated pages? | **Answered for Obsidian 1.8.4, macOS desktop (2026-10-05): the page link works (landed on page 3 of 5) and `&rect=` is not drawn.** Not answered for newer versions, phones or rotated pages | The highlighted rectangle is the nicest part of the preview | Set *Rectangle coordinates* to the top-left origin, or set *Preview with* to Eddie's viewer, which draws the rectangle itself (built, never drawn on a real screen) |
| 6 | Does `app.viewRegistry.typeByExtension` have the shape the claim logic reads, on current Obsidian? | Yes, and anything else is treated as "someone has it" | Otherwise Eddie never claims `.adoc` | Update `holderOf` in `main.ts`; `claimAdoc` setting is the escape hatch |
| 7 | Does Obsidian open a Markdown view, in source mode, for a file whose extension another plugin (AsciiDoc Live) registered? (Its own view has no CodeMirror, so attaching to it is not possible; read from its source.) | Yes, via `setViewState({ type: "markdown" })` | Eddie's marks inside a tab beside the other plugin's preview | The panel and commands still work; the notice "opened in a view Eddie cannot mark up" explains; consider asking the user to enable Eddie's claim |
| 8 | Does `registerExtensions(["adoc"], "markdown")` open `.adoc` in source mode and keep it there? | Yes via `ensureSource` | Otherwise AsciiDoc shows as rendered markdown | Adjust the view-state handling |

## Fixtures to build

- A ~300-page PDF with ~200 annotations of every kind (highlight, strikeout, underline, text, caret, free text), built from a synthetic manuscript, plus the matching `.adoc`.
- A PDF with rotated pages, to check preview coordinates.
- A ~40 MB PDF, to check memory.

`sample/annotate.py` shows how the small sample is produced.

## Devices

macOS desktop (baseline), one iPhone on iOS 17 or later, one mid-range Android phone. Three runs per operation: extract, map, re-map, stamp, report, extract-as-AsciiDoc, preview.

## Results

| Date | Device | OS / Obsidian | Worker mode | Map 5-page | Map 300-page | Longest freeze | Crash | `#page` | `&rect` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  | macOS |  |  |  |  |  |  |  |  |  |
|  | iPhone |  |  |  |  |  |  |  |  |  |
|  | Android |  |  |  |  |  |  |  |  |  |
