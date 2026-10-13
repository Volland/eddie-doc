# CLI host

`eddie` is the command-line Host: every VS Code command as a verb, running the shared core through the same review store, so a review moves between editor and terminal unchanged.

## Commands

Each command in [[src/hosts/cli/commands.ts#COMMANDS]] mirrors one editor command and calls the same store method the editor does.

`open`, `append`, `merge`, `rounds`, `describe`, `delete` and `remap` manage rounds and mappings; `list`, `show`, `resolve`, `reopen`, `confirm`, `relink`, `remap-item`, `triage`, `reply` and `preview` act on annotations; `apply`, `fix`, `anchor` and `strip` edit the source; `report`, `stamp`, `extract` and `map` produce outputs; `status`, `tui`, `folder`, `migrate`, `config` and `version` cover the workspace. `rounds` without a source lists every mapping in the workspace.

Where the editor asks in a dialog, the CLI takes a flag. Where the editor confirms a change to the manuscript or a deletion, the CLI asks on a terminal and requires `--yes` when there is none. `map` and the `stamp --review` / `anchor --review` forms keep their original output byte for byte, which `npm run verify:cli` checks against a snapshot.

## Workspace and selection

Each run builds one store, loads the document's sidecars, mutates, and flushes before exit; the sidecar is the only state between runs.

[[src/hosts/cli/workspace.ts#Workspace]] is the Host: Node storage, notices on stderr, settings from the workspace. With no persistent "active" mapping, a per-document command acts on the newest mapping unless `--mapping` (id, `rev-N/id`, label, origin or sidecar path) or `--round` picks another. An annotation is named by remark number (`7`, `#7`), id, or unique id prefix.

## Terminal UI

`eddie tui` browses documents, mappings and annotations full-screen and acts on them with single keys, the terminal counterpart of the editor's sidebar.

[[src/hosts/cli/tui/app.ts#TuiApp]] holds the state, handles keys and renders a frame as lines, with no terminal in it, so tests drive it with synthetic keys. [[src/hosts/cli/tui/term.ts#runTerminal]] wires it to a TTY: alternate screen, raw keys, resize, keys handled one at a time, terminal always restored. A level with a single choice is skipped. Every action calls the store method the editor calls and flushes, so an open VS Code window sees it. Changes to the manuscript (`f` fix, `A` apply all) show the edit and wait for confirmation. Store notices are routed to the footer instead of stderr, which would tear the screen. No dependency is added: rendering is plain ANSI, and `NO_COLOR` turns colour off.

## Settings like the editor

The CLI must write where VS Code would, so it finds the root VS Code would open and reads the same `eddieDoc.*` keys.

[[src/hosts/cli/config.ts#findWorkspaceRoot]] walks up to the nearest `.eddie.json`, `.vscode`, `.eddie` or `.git`. [[src/hosts/cli/config.ts#loadSettings]] layers defaults, `.vscode/settings.json` (JSONC), `.eddie.json`, `EDDIE_DOC_*` variables and `--set` flags, recording where each value came from for `eddie config`.

## Output discipline

Results go to stdout and diagnostics to stderr, so every command can sit in a pipeline; `--json` puts one JSON document on stdout.

The bundle's banner reroutes `console.*` to stderr and drops pdfjs's import-time polyfill warnings unless `EDDIE_DEBUG` is set. Exit codes: 0 success, 1 an expected failure ([[src/hosts/cli/workspace.ts#CliError]]), 2 a usage error.

## Distribution

The same `dist/cli.js` ships three ways: in the VSIX, as the `@eddie-doc/cli` npm package, and vendored into a manuscript repo.

`scripts/build-cli-package.mjs` copies `cli.js` and `pdf.worker.mjs` into `packages/cli`, whose `bin` exposes `eddie` and `eddie-doc`; the bundle carries a shebang and has no runtime dependencies. The package version is the extension's, kept in step by `scripts/sync-producer.mjs`. The VS Code side of the bundling is in [[vscode#Bundled CLI]].
