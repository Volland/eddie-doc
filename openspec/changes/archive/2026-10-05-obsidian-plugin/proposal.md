> **Status:** implemented in part. The core extraction, async store, Obsidian host, build and docs exist and pass automated checks; nothing has been run in a real Obsidian, the device spike has not run, and several requirements below are not implemented. See "Implementation status (as built)" in `design.md` and the per-task notes in `tasks.md`.

## Why

Eddie Doc maps a **Reviewer**'s PDF annotations onto AsciiDoc source, but it only runs inside VS Code (and a CLI). Authors who write in Obsidian, on desktop and on a phone, cannot use it, and the review logic cannot be reached from any other **Host** because `ReviewStore` (`src/model/store.ts`) and the PDF/matching code are welded to `vscode`, `node:fs`, `node:path`, `node:crypto` and `child_process`. Decisions are recorded in `docs/adr/0001-host-agnostic-core-behind-async-storage-port.md` and `docs/adr/0002-obsidian-claims-adoc-only-if-unclaimed.md`; this change plans their delivery.

## What Changes

- Extract a host-neutral core to `src/core/` (matching, pdf, model, source/markers, thread model, new `core/host/*` ports). The core may not import `vscode`, `obsidian` or `node:fs|path|crypto|child_process`; a `tsconfig.core.json` plus a check script fails the build on violation.
- Introduce an **async storage port** keyed by **Workspace**-relative POSIX paths, a `HostServices` port (notices, typed settings with change events, author name, HTTP, capabilities), a core `Emitter`, and async hashing. `ReviewStore` becomes async and host-neutral. **BREAKING (internal only)**: every `ReviewStore` mutator that persisted synchronously now returns a `Promise`; all VS Code call sites are updated. The on-disk **Review sidecar** format (v3) is unchanged.
- Move the existing VS Code UI to `src/hosts/vscode/` and the CLI to `src/hosts/cli/`, rewritten as thin adapters over the ports. No user-visible VS Code or CLI behaviour change.
- Add an Obsidian plugin (`eddie-doc`, "Eddie Doc", minAppVersion 1.7.2, mobile supported) in `src/hosts/obsidian/`, with:
  - `.adoc` / `.asciidoc` handling: stage 1 claims the extension onto the built-in source editor only when no other handler holds it; stage 2 attaches CodeMirror 6 decorations to an `.adoc` editor owned by another plugin (AsciiDoc Live first).
  - One right-sidebar view, "Eddie Review": filterable annotation list, selected annotation's thread (read-only **Reviewer** mark, replies, resolve) and action buttons.
  - CM6 line highlights, gutter markers and hover in the editor, driven from the shared thread model; live edits feed `posTrack`.
  - PDF preview through Obsidian's built-in PDF viewer (`#page=N&rect=...`), with an own-`ItemView` pdfjs fallback if the spike shows `rect` is unreliable.
  - All 29 `Eddie Doc: ...` commands as Obsidian commands, a `PluginSettingTab` carrying every `eddieDoc.*` setting, vault-PDF `FuzzySuggestModal` pickers, desktop-only native picker with copy-in.
  - Full mobile parity (extract, map, re-map, stamp, report, export) on the same code path, validated by a device spike first and degraded via a core `Capabilities` flag where it fails.
- Obsidian defaults: `reviewFolder` = `Eddie Reviews` (visible; Obsidian does not index or sync dot-folders), `importPdfs` forced on. VS Code and CLI keep `.eddie`.
- Build: one package, several esbuild entries, `dist/obsidian/{main.js,manifest.json,styles.css}`; release assets plus `versions.json`; BRAT first, then the community plugin list; single version shared with the VS Code extension (`release.sh` extended).

## Non-goals

- Rendering AsciiDoc (preview, Live Preview widgets) in Obsidian.
- Inline CM6 block-widget comment threads (a later renderer over the same thread model).
- Splitting into an npm workspaces monorepo (ADR 0001 keeps one package; the layout is a later `git mv`).
- Any change to the sidecar format, matching algorithms or scoring.
- Semantic fallback on mobile.
- Automated verification inside a real Obsidian app (cannot run in CI here; see design Testing strategy).

## Capabilities

### New Capabilities

- `host-core-boundary`: what the host-neutral core may and may not import, the module layout, and the build gate that enforces it.
- `storage-port`: the async workspace-relative storage port, path identity, async `ReviewStore`, change events, hashing, and host services.
- `obsidian-adoc-files`: how the plugin claims or attaches to `.adoc` / `.asciidoc` files.
- `obsidian-review-panel`: the "Eddie Review" sidebar view (list, filters, thread, actions).
- `obsidian-editor-markup`: CM6 highlights, gutter markers, hover and live position tracking.
- `obsidian-pdf-preview`: previewing an annotation's region in the PDF.
- `obsidian-commands`: the Obsidian command set and the mapping from VS Code UI surfaces.
- `obsidian-settings`: the settings tab, defaults and author-name behaviour.
- `obsidian-mobile`: mobile parity, capability flags, progress and the spike protocol.
- `obsidian-distribution`: bundle layout, manifest, release assets, BRAT and community listing.
- `review-sidecar-interop`: a workspace used in VS Code, Obsidian and the CLI reads and writes the same sidecars.

### Modified Capabilities

None. No `openspec/specs/` capability exists yet for the VS Code extension; its behaviour is preserved, not respecified.

## Impact

- Code: every file under `src/` moves (full map in design.md); `src/model/store.ts` async rewrite; new `src/hosts/obsidian/`.
- Build and tooling: `esbuild.js` (new entries, pdfjs strategy), `tsconfig.json` + new `tsconfig.core.json`, `.mocharc.json`, `scripts/` (core-boundary check, obsidian stub), `release.sh`, `package.json` scripts, `.vscodeignore`.
- Dependencies: new dev deps `obsidian`, `@codemirror/state`, `@codemirror/view` (types only; provided by Obsidian at runtime, marked external). pdfjs browser build replaces the legacy build for the Obsidian bundle only.
- Docs and site: README, `site/`, `lat.md/`, `docs/FORMAT.md` (host notes only), CHANGELOG.
- Risk: pdfjs on iOS (worker, memory) and `&rect=` behaviour are unverified assumptions; the spike gates the rest of the Obsidian work.
