# VS Code host

The VS Code extension uses the shared core through the same ports as every Host, and keeps the native surfaces VS Code offers.

## Extension

[[src/hosts/vscode/extension.ts#activate]] builds the host services, creates the review store, and registers the tree view, decorations, diagnostics, code actions, comment threads, status bar item and the `eddieDoc.*` commands.

Storage is the Node adapter, settings are read from `eddieDoc.*` configuration through [[src/hosts/vscode/host.ts#readSettings]], and the author's name falls back to `git config user.name`, which is why that lookup stays in the extension. `deactivate` flushes queued saves so no review state is lost.

## Native surfaces

VS Code's Comments API, Problems panel, tree view and lightbulb are used directly; the Obsidian panel exists because Obsidian has none of them.

Each annotation is a native comment thread whose root post is read-only, because the Reviewer's mark came from the PDF and is immutable under the format's layering rule. Diagnostics use Information severity for unresolved items and Hint for resolved.

## Shared with Obsidian

The classification, thread text and edit planning are core modules, so both hosts agree on which group an annotation is in and what an edit does.

The VS Code extension still carries its own copy of the edit-application code in `extension.ts` and `ui/codeActions.ts`; moving it onto `core/edits/plan.ts` is a follow-up, not done.
