# Obsidian plugin — manual QA checklist

Two automated layers come first. `npm test` and `npm run test:obsidian` cover the shared core, the plugin's pure logic, and the built bundle against a stubbed `obsidian` module. `npm run e2e:obsidian` goes further: it starts a **real desktop Obsidian** on a throwaway vault and checks 65 behaviors (sections 1–7, 9–10 and the AsciiDoc Live pairing below are covered by it on macOS; run it with `E2E_ASCIIDOC_LIVE=1`). What it cannot do is run a phone, other operating systems, or a synced vault, and it cannot judge how anything *looks*. This checklist is for those, and for a person's eye on the screenshots (`E2E_SHOTS=<dir>`). Run it before each release and record the result in the table at the end.

Set up once: a test vault synced to every device you test, containing `sample/chapter-01.adoc` and `sample/chapter-01.annotated.pdf` (and, for the mobile items, the large fixtures from `docs/obsidian-spike-results.md`). Install the plugin by copying `main.js`, `manifest.json`, `styles.css` from `dist/obsidian/` into `<vault>/.obsidian/plugins/eddie-doc/` and enabling it.

Mark each line **pass**, **fail** (note what happened) or **n/a**.

## 1. Load and unload

- [ ] The plugin enables without an error in the developer console.
- [ ] The ribbon icon opens the review panel; the panel's empty state offers *Open PDF review*.
- [ ] The commands appear in the palette under "Eddie Doc" only when they apply: with no review loaded, only the starting ones (open review, show panel, extract, set name, …) are offered; with a review loaded and an annotation selected, the rest appear.
- [ ] Disabling the plugin removes the panel, the editor highlights and the status bar item with nothing left behind; re-enabling restores them.

## 2. AsciiDoc files

- [ ] With no other AsciiDoc plugin, `chapter-01.adoc` opens in the source editor (not reading view) and is editable.
- [ ] Markdown styling is not applied to AsciiDoc syntax (`== Heading` is not shown as a heading).
- [ ] With another plugin that owns `.adoc` (try *AsciiDoc Live*, desktop only), Eddie leaves the extension alone and the console says so.
- [ ] In that case, selecting an annotation opens `chapter-01.adoc` in a **new tab in Obsidian's built-in editor in source mode**, with highlights and gutter badges, while AsciiDoc Live's own tab is unchanged. Record whether Obsidian accepts a Markdown view for a file whose extension another plugin registered (this is the assumption the design rests on).
- [ ] Editing in that tab refreshes AsciiDoc Live's preview in another pane (its README says it does).
- [ ] Setting *Open .adoc files with Eddie* to Never and reloading releases the claim.

## 3. Mapping a review

- [ ] *Open PDF review* → pick the annotated PDF → the mapping completes; the notice reports 5 annotations, all mapped.
- [ ] The PDF was copied into `Eddie Reviews/…/rev-1/pdf/` and the sidecar is at `Eddie Reviews/…/rev-1/chapter-01.review.json`.
- [ ] `// eddie:` comments were added above the annotated paragraphs and the file was saved.
- [ ] A second PDF for the same document offers *start a new round / add to a mapping* and carries resolved state forward.
- [ ] On desktop, *Choose a file from disk…* copies a PDF from outside the vault into the vault.

## 4. Review panel

- [ ] Groups (Open / Needs review / Unmatched / Resolved) show correct counts; the chips filter and the search box filters.
- [ ] Selecting an annotation scrolls the editor to its line and shows its thread.
- [ ] Reply (button and Ctrl/Cmd+Enter) adds a reply; the first reply asks for your name once.
- [ ] Typing in the reply box, then editing the document, does not lose the typed text or the caret.
- [ ] Resolve / Reopen, Confirm match, Re-link to cursor, Pick line…, Re-map each work.
- [ ] Triage unmatched walks through unmatched annotations and links them.
- [ ] Apply to the source: delete struck text, replace, insert, insert note — each is one undo step and resolves the annotation.
- [ ] *Apply all confident edits* lists the edits, applies them in one step.

## 5. Editor markup

- [ ] Annotated lines are highlighted (open, needs-review, resolved look different); gutter badges show remark numbers.
- [ ] Clicking a badge selects the annotation in the panel.
- [ ] Hovering an annotated line shows its text and thread label.
- [ ] Press Enter at the start of an annotated paragraph: the highlight and badge move down with the text and stay correct after the next re-map.
- [ ] Insert and delete lines above and below: the marks stay on their text.
- [ ] End-of-line markers can be switched off in settings, and are never saved into the file.

## 6. PDF preview

- [ ] *Preview PDF* opens the PDF on the annotation's page, in a split.
- [ ] Settings → Preview with → *Eddie's viewer*: the page is drawn with the annotation's rectangle outlined in the right place; ‹ › change page; on a phone it draws without a crash. Record how long a page takes on each device.
- [ ] Record: does Obsidian highlight the rectangle (`&rect=`)? **yes / no / only with PDF++**. On which platforms? If it lands on the wrong corner, does *Rectangle coordinates → Page (origin top-left)* fix it?
- [ ] With a preview open, selecting another annotation moves the preview to its page without taking focus from the list.
- [ ] With the PDF deleted or renamed, a clear notice appears instead of an error.

## 7. Outputs

- [ ] *Export review report* writes the Markdown report to the review folder and opens it.
- [ ] *Stamp reviewed PDF* with a freshly rendered PDF writes `….reviewed.pdf` and opens it; unplaced marks are listed.
- [ ] *Extract annotations as AsciiDoc* writes a readable `.adoc`.

## 8. Interop

- [ ] Open the same project in VS Code with Eddie Doc (reviewFolder set to `Eddie Reviews`): the reviews appear, and a reply added in one host shows in the other after reloading it.
- [ ] The sidecars Obsidian wrote validate against the schema: `npx ajv-cli validate --spec=draft2020 --strict=false -s schema/review-v3.schema.json -d "Eddie Reviews/**/*.review.json"`.

## 9. Mobile (iOS and Android)

- [ ] The plugin enables and the panel opens; list and thread stack with a back button.
- [ ] Touch targets are comfortable; reply box and keyboard do not hide the Reply button.
- [ ] Mapping the sample PDF completes. Record time, and the worker mode if shown in the console (worker / main-thread).
- [ ] Mapping the ~300-page fixture: record time, whether the UI stays responsive, and any crash or memory warning.
- [ ] Re-map, stamp and report on the large fixture: record each.
- [ ] Semantic fallback is not offered in settings.
- [ ] After mapping on desktop and syncing, the review appears on the phone; a reply added on the phone appears on desktop after sync.

## 10. Sync and renames

- [ ] With Obsidian Sync (or iCloud) on, a reply added on device A appears on device B without reloading the plugin (within a few seconds of the sync).
- [ ] Add a different reply on each device while both are offline, then sync: both replies are present on both devices, a `*.conflict-*.txt` file sits beside the sidecar, and a notice was shown. Resolved flags are those of the device you were using.
- [ ] Rename `chapter-01.adoc` in the file explorer: the review is still attached, and the sidecar's recorded source path now names the new file.
- [ ] Rename the PDF the review points at, and the *Eddie Reviews* folder: the review stays attached, and the *Review folder* setting shows the new name.
- [ ] Delete a sidecar on one device: the other forgets the mapping once synced, and an unsaved change is not lost.

## 11. Long operations

- [ ] Mapping shows page progress; clicking the notice, or running *Cancel the running operation*, stops it at the next page and leaves no half-written review.
- [ ] The UI stays responsive while mapping the ~300-page fixture (record the longest freeze).

## 12. Menus and filters

- [ ] Right-click an annotated line: resolve / reopen, show in panel, preview, and the simple edits are offered. Right-click a PDF in the file explorer: *Eddie: map this PDF…*.
- [ ] Kind and page filters work, and are still set after restarting Obsidian.

## Result log

| Date | Version | Platform | Obsidian | Pass | Fail / notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-05 | 1.3.0 build | macOS (automated, `npm run e2e:obsidian`) | 1.8.4 | 65 of 65 | Sections 1–7, 9, 10 (emulated), AsciiDoc Live 1.0.1 pairing. Not covered: how it looks to a person, sync, section 8 interop with VS Code, large PDFs |
| 2026-10-05 | 1.3.0 build | macOS (automated) | 1.13.7 | 65 of 65 | Same; Obsidian 1.13.7 first asks whether to trust the vault's author |
|  |  | Windows |  |  |  |
|  |  | iOS |  |  |  |
|  |  | Android |  |  |  |
