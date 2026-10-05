# Obsidian host

The Obsidian plugin gives Eddie Doc's full review workflow to Obsidian on desktop and mobile, on the same core as the VS Code extension. This file records how each VS Code surface maps onto Obsidian and the constraints that shaped it.

## Plugin shell

[[src/hosts/obsidian/main.ts#EddiePlugin]] wires the Host together on load: settings, PDF engine, storage, the review store, the panel, commands, editor extensions and vault events.

It waits for the workspace layout to be ready before claiming `.adoc`, so loading order cannot make it take an extension a later plugin would have registered. Everything is registered through Obsidian's `register*` helpers so unloading is clean, and unload flushes any queued save.

### Storage on a vault

[[src/hosts/obsidian/storage.ts#ObsidianStorage]] uses the Vault API wherever Obsidian indexes the path, so the metadata cache, other plugins and Sync see an ordinary edit, and falls back to the Adapter API for what the index cannot see.

The fallback covers a dot-folder (never indexed), a file Obsidian has not noticed yet, and directory listings, which must reflect the disk. Creating something that is already on disk but not indexed is caught and written through the adapter. Deletion goes through the file manager, so the user's trash preference applies. Parent folders are created one segment at a time because a recursive mkdir is not guaranteed on every adapter. It uses no Node API.

### Settings

Obsidian settings are the same keys as VS Code's with two differences forced by the platform, plus one Obsidian-only setting.

[[src/hosts/obsidian/pure/settingsMap.ts#sanitizeSettings]] repairs whatever `data.json` holds. `reviewFolder` defaults to a visible `Eddie Reviews` and must stay inside the vault, because Obsidian neither indexes nor syncs dot-folders. `importPdfs` is pinned on, because a PDF outside the vault is unreadable on mobile. `claimAdoc` (`auto` or `never`) controls `.adoc` ownership.

## Review panel

One side panel replaces the VS Code tree view, Problems panel, comment threads and lightbulb actions.

[[src/hosts/obsidian/ui/ReviewView.ts#ReviewView]] shows the document and round, filter chips with counts per group, a search box, the grouped annotation list, and the selected annotation's thread with every action on it. On a narrow screen or on mobile it shows the list or the thread, not both. Unsent reply text and scroll position survive a refresh.

### Thread

The thread shows the Reviewer's mark as read-only, the author's replies, and a reply box; replies are the author's authored content and are never recomputed.

Thread header and root text come from [[src/core/thread/threadModel.ts#threadLabel]] and `rootMarkdown`, shared with VS Code, and are rendered as Markdown because the text is the Reviewer's quote and note, not AsciiDoc. A reply needs a name; Obsidian cannot read a git identity, so the plugin asks once and remembers.

### Actions

Every action is a plain function in `flows.ts` that both a panel button and a command-palette command call.

The set mirrors VS Code's: resolve, confirm match, reveal, preview PDF, re-link to the cursor line or from a picked line, re-map, apply a suggested edit, apply all confident edits, triage unmatched, anchor, strip anchors, export report, stamp a PDF, extract annotations. [[src/hosts/obsidian/commands.ts#registerCommands]] registers 32 commands, each offered only when it applies (a review is loaded, an annotation is selected, there is something to migrate, the Host is desktop). The five reply commands VS Code needs are the reply box here and have no palette entry.

### Filters

The panel narrows by group, kind of mark, page and text, and remembers the choice between sessions.

The filters are UI state kept in the plugin's own data, never in a sidecar, so they follow the device and not the review.

## Keeping up with the vault

Obsidian is a shared, synced, renamed-at-will folder, so the plugin follows what happens to the files instead of assuming it owns them.

A changed, new or deleted sidecar is re-read after a short quiet period; the store ignores the echo of its own write. A renamed manuscript, PDF, sidecar or review folder re-keys the loaded reviews and rewrites their recorded paths, and renaming the review folder updates the setting. The store rules are in [[architecture#Persistence#Changes from other devices]].

## Editor markup

Highlighted lines, gutter number badges, hover text and an optional end-of-line glyph show annotations inside the editor; none of it is written to the file.

[[src/hosts/obsidian/editor/extension.ts#markupField]] keeps the marks as CodeMirror line decorations in one state field, and the gutter and hover read their data out of those decorations. CodeMirror therefore maps them through every edit itself, and the gutter can never disagree with the highlighted lines for the frame between a keystroke and the next refresh.

### Mapping a line to a mark

[[src/hosts/obsidian/pure/markupModel.ts#buildMarkup]] decides which lines carry which annotations, with no editor involved.

Open work outranks resolved on a shared line. Spans are clamped to the document so a stale mapping never decorates a line that does not exist. Unplaced annotations and, when hidden by the setting, resolved ones produce nothing.

### Live edits

Edits feed back into the core's line tracking so annotations keep pointing at their text between saves.

[[src/hosts/obsidian/pure/changes.ts#toContentChanges]] converts a CodeMirror change set into `ContentChange`s in descending order. An insertion of whole lines at column 0, such as pressing Enter at the start of a paragraph, is reported at the end of the previous line, because `shiftLine` assumes an edit's first line stays put and that paragraph must move down.

## AsciiDoc files

Obsidian does not open `.adoc`, and only one plugin can own an extension, so Eddie claims `adoc` and `asciidoc` only when nobody else has.

[[src/hosts/obsidian/pure/claimDecision.ts#decideClaim]] returns claim only for an unheld extension with the setting on auto. An unrecognised view registry counts as held, because wrongly claiming would break another plugin and wrongly abstaining only costs the standalone editor. Claimed files open in the markdown source editor. Rendering AsciiDoc is a non-goal. The decision and rejected alternatives are in `docs/adr/0002-obsidian-claims-adoc-only-if-unclaimed.md`.

### Pairing with another AsciiDoc plugin

When another plugin owns the extension, Eddie opens the file in Obsidian's built-in editor in source mode, in its own tab, beside that plugin's view.

[[src/hosts/obsidian/pure/claimDecision.ts#openModeFor]] decides: Markdown and Eddie's own claims open normally, anything else opens as a Markdown view. AsciiDoc Live, the likeliest partner, is desktop-only and its view is rendered HTML with a plain textarea, so no CodeMirror markup can be drawn on it; it refreshes its preview from the built-in editor's changes, which makes the side-by-side pairing work. A foreign view that does expose a CodeMirror editor is still attached to as a best effort. Checked with AsciiDoc Live 1.0.1 on Obsidian 1.8.4 and 1.13.7: Obsidian accepts the Markdown view, and AsciiDoc Live's preview follows edits made in it.

## PDF preview

The PDF behind an annotation opens at the right page with its rectangle marked, in Eddie's own viewer by default or in Obsidian's built-in viewer.

[[src/hosts/obsidian/pure/pdfRect.ts#pdfFragment]] builds `#page=N&rect=l,b,r,t` from the annotation's PDF-space rectangle, clamped to the page and dropped when it is degenerate. That link is what Obsidian's built-in viewer is opened with. On Obsidian 1.8.4 it lands on the right page and ignores `rect`. Either viewer reuses one tab and follows the selection without taking focus from the list.

### Eddie's own viewer

A setting switches the preview to a view that draws the page and the marked rectangle itself, for when the built-in viewer ignores or misplaces `rect`.

[[src/hosts/obsidian/ui/PdfPreviewView.ts#PdfPreviewView]] renders one page to one canvas through pdfjs and places the rectangle with pdfjs's own viewport transform, which already handles origin and rotation. The scale is capped on mobile and a stale draw is discarded. The `pdfRectMode` setting flips the coordinates used for the built-in viewer's link. Eddie's viewer has been checked on desktop Obsidian only: the page paints and the marker lies on it. Obsidian 1.8.4's built-in viewer lands on the page but does not draw `rect`, which is why Eddie's viewer is the default.

## PDF engine on mobile

pdfjs's browser build runs with its worker embedded in `main.js`, started from a Blob URL, and falls back to the main thread when a WebView refuses a Blob worker.

[[src/hosts/obsidian/pdf/engine.ts#useObsidianPdfEngine]] picks the mode. The fallback runs the same worker code from a copy bundled as an ordinary module, so no script element is created and nothing is evaluated. The build also replaces pdfjs's `new Function` calls with a throwing stub (see `noDynamicCode` in esbuild.js), so the bundle holds no dynamic code at all.

### Not leaving a global behind

pdfjs's worker module sets `globalThis.pdfjsWorker` when imported, and Obsidian's own PDF viewer reads that global from the same window.

Left set, it makes the built-in viewer run the plugin's worker code instead of its own, and it stopped landing on the right page. The import is wrapped so the global is restored, and in fallback mode it is offered to pdfjs only for the duration of the one synchronous `getDocument` call that reads it. The end-to-end suite checks that the window is clean after loading and after a fallback-mode mapping. This was found only by that suite.

`npm run verify:obsidian-engine` checks the fallback against the sample PDF under Node. In desktop Obsidian 1.8.4 and 1.13.7 the Blob worker starts and parses it, and with `Worker` made unavailable the fallback maps all five annotations. Whether a phone's WebView accepts the Blob worker, and the speed on a large PDF there, can only be checked on a device.

## Capabilities

Where a device cannot do something the plugin turns the feature off instead of forking the code.

[[src/hosts/obsidian/host.ts#detectCapabilities]]: the semantic fallback needs a localhost Ollama server and is desktop-only, and it goes through Obsidian's `requestUrl` so CORS cannot block it. Reading a file from outside the vault is desktop-only, and the file is copied into the vault.

## Distribution

A release is three files, `main.js`, `manifest.json` and `styles.css`, built and attested by CI and attached to a GitHub release with the repository's version.

`manifest.json` and `versions.json` live at the repository root, as the community plugin list requires, and the build copies the manifest into `dist/obsidian` with the version from `package.json`. Version 1.4.0 is the first release. It has been run in a real desktop Obsidian by the end-to-end suite and tried by hand on a phone, with no measurements; the manual checklist is `docs/obsidian-qa.md`. The release workflow is the only publisher: it attests the files (provenance, checkable with `gh attestation verify`) and uploads exactly those bytes, so a local build can never replace them. `scripts/sync-producer.mjs` keeps the manifest and `versions.json` on the package version, and `release.sh` attaches the three files. What has and has not been checked is recorded in `docs/obsidian-spike-results.md`.
