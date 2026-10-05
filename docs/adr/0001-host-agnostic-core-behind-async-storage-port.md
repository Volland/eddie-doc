# Host-agnostic core behind an async storage port, one package

Eddie Doc runs in VS Code, Obsidian (desktop and mobile) and the CLI. The matching, PDF, model and marker code moves to `src/core/`, which may not import `vscode`, `obsidian`, or Node's `fs`, `path`, `crypto` or `child_process`; each **Host** lives in `src/hosts/<name>/` and supplies file access, settings, notices, the author name and the editor UI. A dedicated `tsconfig.core.json` without host types makes a leaking import fail the build.

File access goes through an async storage port keyed by workspace-relative POSIX paths. It is async because Obsidian's vault adapter and mobile filesystems have no sync API, so `ReviewStore` (today ~19 `fs.*Sync` calls, absolute-path session keys, `vscode.EventEmitter`, `window.show*Message`) becomes async and host-neutral.

## Considered options

- **npm workspaces monorepo** (`core`, `vscode`, `obsidian`, `cli` as separate packages). Rejected for now: it forces rework of `vsce` packaging, `release.sh` and `.vscodeignore`, and gives independent versions we do not want while the sidecar format and both hosts still move together. Single-package layout is arranged so this is a later `git mv`.
- **Desktop-only Obsidian**, keeping `fs`. Rejected: mobile is in scope, and mobile has no `fs`.

## Consequences

- Mobile gets full parity (extract, map, stamp, report) on the same code path. A spike on a real phone with a ~300-page PDF comes first; if an operation fails there, it degrades behind a capability flag rather than forking the code.
- Obsidian's default `reviewFolder` is a visible `Eddie Reviews/` with `importPdfs` forced on, because Obsidian does not index or sync dot-folders and a PDF outside the vault is unreadable on mobile. VS Code and the CLI keep `.eddie`.
- Semantic fallback (Ollama at localhost) is desktop-only.
