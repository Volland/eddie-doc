# Architecture

Eddie Doc is one TypeScript package with a host-neutral core and a thin adapter per Host: VS Code, Obsidian (desktop and mobile) and the command line. This file explains the split and the rules that keep it true.

## Hosts and core

All review logic lives in `src/core/` and runs unchanged in every Host; each Host in `src/hosts/<name>/` supplies files, settings, notices and the editor UI.

The core never imports `vscode`, `obsidian`, CodeMirror, or Node's `fs`, `path`, `crypto` or `child_process`. A Host plugs in through the ports below, so adding a fourth Host means writing adapters, not touching review logic. The rationale and rejected alternatives are in `docs/adr/0001-host-agnostic-core-behind-async-storage-port.md`.

### Boundary enforcement

Two gates fail the build when the core leaks a host: an import scan and a type-check with no host or Node types available.

`scripts/check-core-boundary.mjs` scans `src/core` and the Obsidian host's `pure/` folder for forbidden imports, comments excluded. `tsconfig.core.json` compiles `src/core` with `types: []`, so a stray `Buffer`, `process` or `__dirname` cannot type-check. `npm run check:core` runs both and is part of `build` and `pretest`.

### Why not a monorepo

One package keeps a single version and one release for the sidecar format and both hosts, which still change together.

`src/core` is arranged so splitting it into a published package later is a directory move. The cost accepted now is that the boundary is enforced by the scripts above rather than by package boundaries.

## Ports

A Host hands the core four things: storage, services, a PDF engine and a hash function it does not need to supply.

### Storage

[[src/core/host/storage.ts#Storage]] is the core's only way to touch files, and it is async because Obsidian's vault adapter and mobile filesystems have no synchronous API.

Paths are `/`-separated strings, workspace-relative or absolute. `exists` and `list` never reject; a missing folder is an ordinary answer. Implementations: [[src/hosts/node/nodeStorage.ts#NodeStorage]] for VS Code and the CLI, [[src/hosts/obsidian/storage.ts#ObsidianStorage]] for a vault, and [[src/core/host/memoryStorage.ts#MemoryStorage]] for tests.

### Host services

[[src/core/host/services.ts#HostServices]] bundles storage with notices, live settings, the author's name, capability flags and an optional `fetch`.

It replaces what `ReviewStore` used to take from `vscode` directly: message boxes, `getConfiguration`, an event emitter, and a `git config` lookup. [[src/core/host/services.ts#Capabilities]] states what a device cannot do, so the core degrades by flag instead of forking: mobile has no localhost for the semantic fallback and cannot read files outside the vault.

### PDF engine

The core reaches pdfjs only through [[src/core/pdf/engine.ts#PdfEngine]], which each Host installs with `setPdfEngine` before the first extraction.

Node hosts install the legacy build with a worker file ([[src/hosts/node/pdfEngine.ts#useNodePdfEngine]]). Obsidian installs the browser build with the worker embedded in `main.js` as text ([[src/hosts/obsidian/pdf/engine.ts#useObsidianPdfEngine]]), because a worker cannot be loaded from a file inside a plugin on mobile.

### Hashing

[[src/core/util/sha256.ts#sha256Bytes]] is a synchronous pure-TypeScript SHA-256, because anchor fingerprints and sidecar integrity are computed in code that cannot await.

`node:crypto` does not exist on mobile and WebCrypto is promise-only. Output is byte-identical to `createHash("sha256")`, and a test holds it to that at every padding boundary.

## Path identity

Every path in the core is a normalized `/`-separated string, and a session is keyed by its normalized sidecar path.

[[src/core/util/path.ts]] replaces `node:path`. Hosts convert at their edge: VS Code and the CLI keep absolute paths, an Obsidian vault uses vault-relative paths with an empty `workspaceRoot`. The empty root is a real value; `reviewRoot` must not treat it as missing or Obsidian silently falls back to the legacy layout.

## Persistence

Mutators change memory immediately and queue the save; the file write is coalesced and serialized, and `flush()` waits for it.

[[src/core/model/store.ts#ReviewStore#flush]] resolves when every queued sidecar has reached storage. A burst of edits to one mapping is one write. A mapping deleted while a save is queued is not resurrected. A failed save is reported through the notifier and leaves the in-memory state intact. Operations that must see the file on disk, such as merging or migrating, flush first. The reasoning, and what it does not protect against (two Hosts editing one review at once), is in `docs/adr/0003-saves-are-queued-not-synchronous.md`.

### Changes from other devices

A sidecar changed by another device or sync client is detected by hash, merged rather than overwritten, and a copy of the other version is kept.

[[src/core/model/store.ts#ReviewStore#reloadFromDisk]] re-reads a changed file unless it is the echo of this store's own write or there is unsaved work, which the write reconciles. On a conflict, replies and annotations present only in the other copy are added, the other copy is saved beside the file as `*.conflict-<time>.txt`, and the author is told. Resolved flags are not merged because there is no record of which side changed them. [[src/core/model/store.ts#ReviewStore#rebindPaths]] follows a renamed manuscript, PDF, folder or sidecar.

### Long operations

Reading a PDF reports per-page progress, honours cancellation, frees each page and yields to the UI on a time budget.

[[src/core/host/progress.ts#timeSlicer]] yields only once its budget is spent, so the check is nearly free on a desktop and keeps a phone responsive. Cancellation rejects with `CancelledError` at the next page.

## Build outputs

One `esbuild.js` produces the VS Code extension, the CLI, the benchmark and the Obsidian plugin from the same tree.

`dist/extension.js` and `dist/cli.js` target Node. `dist/obsidian/{main.js,manifest.json,styles.css}` targets a browser environment, treats `obsidian`, `electron` and CodeMirror as external, and fails if any Node builtin appears in the output.
