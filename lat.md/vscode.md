# VS Code host

The VS Code extension uses the shared core through the same ports as every Host, and keeps the native surfaces VS Code offers.

## Extension

[[src/hosts/vscode/extension.ts#activate]] builds the host services, creates the review store, and registers the tree view, decorations, diagnostics, code actions, comment threads, status bar item and the `eddieDoc.*` commands.

Storage is the Node adapter, settings are read from `eddieDoc.*` configuration through [[src/hosts/vscode/host.ts#readSettings]], and the author's name falls back to `git config user.name`, which is why that lookup stays in the extension. `deactivate` flushes queued saves so no review state is lost.

## Bundled CLI

The extension ships the `eddie` CLI and makes it usable without a Node install: it is on every integrated terminal's PATH and can be linked into the shell's.

[[src/hosts/vscode/cli.ts#installCliFiles]] copies `dist/cli.js` and its pdfjs worker into global storage, because the extension's own folder is renamed on every update, and writes an `eddie` launcher that runs them on VS Code's runtime with `ELECTRON_RUN_AS_NODE`, falling back to `node`. [[src/hosts/vscode/cli.ts#exposeOnTerminalPath]] prepends that folder to terminal PATHs (setting `eddieDoc.cli.addToTerminalPath`). The commands `Install 'eddie' Command in PATH` and `Open Terminal with Eddie CLI` cover other shells. The CLI itself is described in [[cli]].

## Agent skills command

*Install Agent Skills for AI Tools…* asks which AI coding tools the author uses and where, then installs Eddie's skills; see [[agent-skills#Entry points]].

## Sidecars changed on disk

A sidecar changed outside the window, by `eddie` in a terminal, a sync client or another editor, is re-read so the tree shows what is on disk.

A file watcher on `**/*.review.json` calls [[src/core/model/store.ts#ReviewStore#reloadFromDisk]] once writes settle, the same path Obsidian takes. The store ignores the echo of its own writes and keeps unsaved work for its next write to reconcile.

## Native surfaces

VS Code's Comments API, Problems panel, tree view and lightbulb are used directly; the Obsidian panel exists because Obsidian has none of them.

Each annotation is a native comment thread whose root post is read-only, because the Reviewer's mark came from the PDF and is immutable under the format's layering rule. Diagnostics use Information severity for unresolved items and Hint for resolved.

## Shared with Obsidian

The classification, thread text and edit planning are core modules, so both hosts agree on which group an annotation is in and what an edit does.

The VS Code extension still carries its own copy of the edit-application code in `extension.ts` and `ui/codeActions.ts`; moving it onto `core/edits/plan.ts` is a follow-up, not done.
