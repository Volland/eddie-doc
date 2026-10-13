---
lat:
  require-code-mention: true
---
# Tests

Specifications for the tests that guard the host-neutral core and the Obsidian host's pure logic. Each leaf names one suite and what it protects.

## Core utilities

The small, dependency-free pieces the core stands on, which must behave identically in every Host.

### Sha256 matches node crypto

The pure-TypeScript hash must produce the same digests as `node:crypto`.

It is checked at every padding boundary, on UTF-8 text and on a multi-megabyte input, because sidecar integrity and anchor fingerprints are compared across Hosts.

### Core path dialect

The `/`-separated path helpers must agree with `node:path.posix` on ordinary paths.

A drive letter counts as absolute, so a Windows path converted at the Host edge still resolves.

### Memory storage

The in-memory storage must behave like a vault.

Folders are implied by files, reads return copies, a missing folder lists as empty, and reading a missing file rejects.

### Storage contract

Every storage implementation must behave the same, so the core cannot tell a disk from a vault.

The suite runs against the in-memory storage and the Node one: writes create parent folders, reads of a missing file reject, `exists` and `list` never reject, removing a missing file is quiet, copy creates folders, and returned bytes are copies.

### Event emitter

The core's event type must deliver in order, isolate a failing listener and stop after dispose.

### Layout with an empty root

An empty workspace root, which is how an Obsidian vault is addressed, must be a real root.

It gives a visible review folder at the vault root, mirrors the manuscript tree under it, and still falls back to the legacy layout only when the review folder setting is empty.

## PDF reading

How long extraction behaves, so a phone stays usable.

### Progress and cancellation

Extraction must report each page, stop at the next page once aborted, and yield only when its time budget is spent.

Page geometry is read from the PDF on demand, and a missing page or unreadable file gives undefined rather than throwing.

## Review store

The store's behavior on the storage contract Obsidian provides.

### Vault-style storage

The store must run entirely on a relative-path storage with an empty workspace root.

It maps a PDF, reloads from the files alone, coalesces a burst of edits into one write, does not resurrect a deleted mapping, survives a failed save, and ignores the semantic fallback where the Host cannot reach it.

### Changes from another device

A sidecar changed by another device or sync client must be picked up, merged rather than overwritten, and followed when renamed.

Its own write echoing back is not a change. A reply from each device both survive, with the other copy kept and the author told. A deleted file is forgotten unless there is unsaved work. A renamed manuscript, PDF, folder or sidecar is followed and the recorded paths rewritten.

## Edits

Source edits suggested by annotations, as plain offsets.

### Edit planning

Suggested edits must be exact offsets that any Host can apply as one change.

It deletes only the struck words and one neighbouring space, replaces marked text, inserts after a caret mark, deletes whole lines including the last, inserts a note keeping indentation and line endings, and plans nothing for an unplaced mark.

## CLI

The `eddie` command line, driven in-process through its dispatcher against a temporary copy of the sample chapter.

### Argument parsing

Positionals, value flags, booleans and repeated flags must be told apart without a per-command schema.

A lone `-` (stdin), a negative number and everything after `--` are positionals, and a value flag with no value is a usage error.

### Settings like the editor

Settings must be read the way VS Code reads them, so the CLI writes where the editor would.

`.vscode/settings.json` is JSONC; it is layered under `.eddie.json`, `EDDIE_DOC_*` variables and flags, each value's source is recorded, the workspace root is found from a subfolder, and an unknown `--set` key is refused.

### Every command documented

Every command must have a summary, a usage line, and appear in `eddie help`; an unknown command exits with 2.

### Review lifecycle from the terminal

A whole review must run from the CLI and leave sidecars the editor's store reads back unchanged.

Mapping writes into the review folder and anchors the source; remarks are listed, resolved, answered and confirmed by number; a hand link and a re-map round-trip; `apply` refuses to write without `--yes`; the report and the stamped PDF land in the round folder; a new round carries state forward; a mapping is deleted only when named and confirmed; a document with no review fails clearly.

### Terminal UI

The full-screen browser must navigate, act and write the sidecar exactly as the commands do, and fit any screen it is given.

It skips single-choice levels, keeps every line within the width, goes back and quits; resolves, replies and relinks to a typed line; filters by group and text; applies a fix only after showing the diff and confirming; offers ranked triage lines; and lists every key on `?`.

## Annotation view

How a review list groups and filters annotations, shared by every Host.

### Classification and filtering

An annotation must land in exactly one of Open, Needs review, Unmatched or Resolved.

Filters, counts and grouping agree with that, so every Host's list shows the same thing.

## Obsidian host

Logic that runs without Obsidian, so it can be tested in plain Node.

### Claiming adoc

`.adoc` is claimed only when no other plugin holds the extension and the setting allows it.

An unrecognised view registry counts as held.

A file whose extension Eddie did not claim opens in Obsidian's built-in editor in source mode, so its markup can show beside the other plugin's preview.

### Settings sanitising

Corrupt or out-of-range values in `data.json` must be repaired rather than fail.

The review folder must stay inside the vault and `importPdfs` must stay on.

### PDF link

The preview link must target the right page.

The rectangle is normalized and clamped, dropped when degenerate, and flipped to a top-left origin when asked.

### Markup model

Lines must be marked from an annotation's span, badged only where it starts.

Open work outranks resolved on a shared line, and nothing is marked beyond the end of the document.

### View field names

A view class must not declare a field that replaces one of Obsidian's own view members.

The preview view once declared `titleEl`, which overwrote Obsidian's and made Obsidian fail to open it, something no unit test could otherwise see. The suite reads the base members from Obsidian's typings and checks every view file.

### Editor decorations

The editor markup must be built against a real CodeMirror state and stay on its text.

Open, needs-review and resolved lines look different. The gutter and hover read the annotations from the decorations themselves. Inserted or deleted lines move or drop the marks without a new push, a second push replaces the first, and a stale mapping never decorates a missing line.

### Editor changes

CodeMirror edits must be converted so the core's line tracking agrees with CodeMirror's own position mapping.

That includes several edits in one transaction and a paragraph pushed down by Enter at column 0.
