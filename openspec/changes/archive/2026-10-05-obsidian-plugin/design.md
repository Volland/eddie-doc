## Implementation status (as built)

This design was written before implementation. What follows is where the code differs from it, so the rest of this document should be read as the target, not as a description of the repository. Task-level status is in `tasks.md`; the decisions that changed are in `docs/adr/0003-saves-are-queued-not-synchronous.md`.

**Built and verified by automated checks:** the host-neutral core and its boundary gates (D1); the async `Storage` port with Node, Obsidian and in-memory implementations (D2, D7, D8); the async `ReviewStore` with queued saves; the Obsidian plugin shell, review panel, editor markup, settings tab, 30 commands and flows; the pure Obsidian logic (claim decision, settings sanitising, PDF link, markup model, CodeMirror change mapping); the `esbuild` Obsidian bundle with an embedded pdfjs worker and a no-Node assertion; and shared view/edit modules (`core/view/annotationView.ts`, `core/edits/plan.ts`). `npm test` (319), `npm run check:core`, `npm run verify:obsidian-engine`, `npm run smoke:obsidian`, `lat check` and `openspec validate` pass.

**Built, never run in real Obsidian:** everything that touches Obsidian's own APIs or UI — the panel's rendering, the CodeMirror decorations, `.adoc` claiming against the real view registry, attaching to another plugin's editor, the built-in PDF viewer link, the Blob-worker path, and anything on iOS or Android.

**Deviations from the design**

| Design | As built |
| --- | --- |
| D2/D4: `sha256Hex` async via WebCrypto plus a sync variant | One synchronous pure-TypeScript `sha256Bytes`/`sha256Text` in `core/util/sha256.ts`, held equal to `node:crypto` by tests |
| D4: every mutator is async and its promise resolves after the write | Per-item mutators stay synchronous in memory; `persist` queues a coalesced, serialized write; `flush()` waits for it (ADR 0003) |
| D4: per-sidecar lock, hash check before write, replay on conflict, `reloadFromDisk`, `rebindPaths` | Hash check, merge-on-conflict (not replay), `reloadFromDisk` and `rebindPaths` are built. A single drain queue replaces per-sidecar locks. Merging covers replies and added annotations; resolved flags and edits to the same reply are not merged |
| D6: module move map (`core/host/*`, `core/test/`, `core/benchmark/`) | `core/{host,util,matching,model,pdf,source,thread,view,edits}`; tests stay in `src/test/`; benchmark under `hosts/cli/benchmark/`; shared Node adapters in `hosts/node/` |
| D2: core `sanitizeSettings` | Lives in `hosts/obsidian/pure/settingsMap.ts`; core has `Settings` and `DEFAULT_SETTINGS` |
| D2: `HttpPort`, `Progress`, `Capabilities` with `pdfExtract`, `pdfStamp`, `pdfWorker`, `maxPdfBytes`, `builtinPdfRect`, `rectMode` | `Progress` (report, signal, time-sliced yielding) is built. `Capabilities` has only `semanticFallback` and `externalFiles`; HTTP is `HostServices.fetch`; `rectMode` and `preview` are user settings (`pdfRectMode`, `pdfPreview`) instead of spike-derived flags, since the spike has not run |
| D8/D9: `checkCallback` conditions, editor-menu and file-menu entries, `import-pdf-from-disk` command, own preview view | Built (32 commands). The own preview view has never been drawn on a real screen |
| D8: vault `modify`/`delete`/`rename` handling for sidecars | Built: re-map on source modify, sidecar reload on modify/create/delete, rebind on rename (including the review folder) |
| D11: page geometry and rotation | `readPageGeometry` reads the box and rotation and the link clamps/flips with it; no rotation transform |
| D15: `scripts/obsidian-stub.cjs` for mocha | A minimal stub (one CodeMirror state field) lets host modules load under mocha; the plugin as a whole is exercised by `scripts/smoke-obsidian.cjs` (stub module + strict in-memory vault) against the built bundle; the pure modules are tested without any stub because they import nothing from Obsidian |
| D8: ReviewView keyed rows, `threadSignature`-gated re-render | Full re-render that preserves scroll, focus and reply drafts; filters (including kind and page) are persisted |

**Changed after reading AsciiDoc Live's source:** D9/D10's "attach to the other plugin's CodeMirror editor" cannot work for it (its view is a rendered preview with a textarea, desktop-only). Eddie opens its own built-in-editor tab for an unclaimed extension and the two plugins sit side by side; see ADR 0002.

**Added beyond the design:** `claimAdoc: "auto" | "never"` (as the design proposed); `scripts/smoke-obsidian.cjs`; `scripts/verify-obsidian-engine.cjs`; whole-line insertion normalisation in `pure/changes.ts` (found by testing against CodeMirror's own position mapping); the `""` workspace-root fix in `layout.ts` (an empty root was treated as missing and silently selected the legacy layout).

## Context

Today Eddie Doc is one TypeScript package built by `esbuild.js` into three Node/CJS bundles: `dist/extension.js` (from `src/extension.ts`, 2585 lines, `external: ["vscode"]`), `dist/cli.js` (`src/cli.ts`) and `dist/bench.js` (`src/benchmark/main.ts`). Tests are mocha over `out/test/**/*.test.js`, run with `scripts/mocha-vscode.cjs` redirecting `require("vscode")` to `scripts/vscode-stub.cjs`.

What blocks a second **Host**, from the code:

- `src/model/store.ts` (1192 lines) holds the review sessions and is the only writer of **Review sidecars**. It imports `node:crypto` (`randomBytes` for reply ids), `node:fs` (about 19 `*Sync` calls: `readFileSync`, `writeFileSync`, `existsSync`, `copyFileSync`, `unlinkSync`, `mkdirSync`, `readdirSync`, `statSync`), `node:path`, and `vscode` (`vscode.EventEmitter`, `vscode.window.show*Message` x6, `vscode.workspace.getConfiguration("eddieDoc")` inside `runFallbacks`). Session keys are `path.resolve`d absolute paths.
- `src/model/format.ts` (`sha256` via `createHash`, `absFromSidecar` via `path`), `src/model/layout.ts` (`path.join/relative/resolve`, `LayoutConfig.workspaceRoot`), `src/model/report.ts` (`fs.readFileSync` in `isSessionStale`), `src/source/markers.ts` (`createHash` in `fingerprintBlock` and `injectMarkers`), `src/matching/semantic.ts` (`createHash`, `fs`/`path` in `FileEmbedCache`, `fetch` to Ollama), `src/pdf/extract.ts` (`node:path` and `GlobalWorkerOptions.workerSrc = path.join(__dirname, "pdf.worker.mjs")` against the `pdfjs-dist/legacy` build), `src/pdf/toAdoc.ts` (`path`) all use Node.
- `src/extension.ts` mixes UI, file picking, `git config` (`execFileSync` in `authorName()`), and calls to the store.
- UI in `src/ui/*` is VS Code API throughout, except `src/ui/threadModel.ts` (pure) and parts of `precise.ts`.

ADR 0001 fixed the shape (one package, `src/core` plus `src/hosts/<name>`, async storage port) and ADR 0002 the `.adoc` policy; the proposal lists the thirteen product decisions this design encodes. This document says how.

## Goals / Non-Goals

**Goals:**

- A core with no host or Node imports, verified by the build.
- VS Code and CLI behaviour unchanged, sidecar bytes unchanged (apart from timestamps), tests green after every migration step.
- An Obsidian plugin with full desktop and mobile parity on the same core code path.
- Failures on a device degrade through `Capabilities`, never through a code fork.

**Non-Goals:**

- No monorepo, no format change, no new matching behaviour.
- No AsciiDoc rendering, no inline CM6 widget threads (the thread model stays renderer-neutral so a later renderer can add them).
- No automated test inside real Obsidian (see Testing strategy).

## Architecture

```
                         src/core/  (no vscode / obsidian / node:fs|path|crypto|child_process)
 +----------------------------------------------------------------------------------------+
 |  matching/   pdf/         model/                     source/    thread/   view/         |
 |  mapper      extract*     types format layout        markers    thread    annotation    |
 |  align       locate       numbering refs combine     precise    Model     View (rows,   |
 |  fuzzy       anchor       report  store(async)                            filters,      |
 |  lexical     stamp        ^                                               spans,        |
 |  semantic*   toAdoc       | uses                                          actions)      |
 |  posTrack                 |                                                             |
 |  normalize    host/  <----+---- ports implemented by each host                          |
 |    storage.ts services.ts capabilities.ts events.ts posix.ts hash.ts sha256.ts          |
 |    http.ts random.ts memoryStorage.ts(tests)   pdf/engine.ts (PdfEngine port)            |
 +----------------------------------------------------------------------------------------+
        ^                          ^                                   ^
        | StoragePort+HostServices | StoragePort+HostServices          | StoragePort+HostServices
        | PdfEngine(node legacy)   | PdfEngine(node legacy)            | PdfEngine(browser, inline worker)
 +--------------+        +----------------+                    +-----------------------------+
 | hosts/vscode |        | hosts/cli      |                    | hosts/obsidian              |
 | vscode.fs    |        | node:fs        |                    | vault + adapter             |
 | Comments API |        | argv/stdout    |                    | ItemView "Eddie Review"     |
 | Diagnostics  |        | bench          |                    | CM6 decorations/gutter/hover|
 | CodeActions  |        +----------------+                    | built-in PDF viewer / own   |
 | Tree, Webview|                                              | PluginSettingTab, commands  |
 +--------------+                                              +-----------------------------+
   dist/extension.js      dist/cli.js, dist/bench.js              dist/obsidian/{main.js,manifest.json,styles.css}
```

`*` extract and semantic reach pdfjs and the network through ports (`PdfEngine`, `HttpPort`), never directly.

### Data flow (Obsidian)

```
 vault.modify(.adoc) --debounce--> store.remapAll(skipUnchanged) --> sidecar write (StoragePort)
 CM6 ChangeSet ------------------> store.shiftPositions(ContentChange[])  (in memory)
 store.onDidChange(adocPath) ----> ReviewController (rAF-coalesced)
                                      |-> ReviewView.refresh()    (list, thread, header)
                                      |-> editors: dispatch(setMarkup(model))   (CM6 StateField)
                                      |-> StatusBar item (desktop)
 ReviewView action ---------------> store.<mutator>() (async, persisted) --> onDidChange
```

## Decisions

### D1. Core boundary and enforcement

`src/core/**` may not import `vscode`, `obsidian`, `electron`, or `fs|path|crypto|child_process|os|process|buffer` (any form, with or without `node:`), and may not use the globals `process` or `Buffer`. Enforcement is two-layered:

1. `tsconfig.core.json`: `{"extends": "./tsconfig.json", "compilerOptions": {"types": [], "lib": ["ES2022"], "noEmit": true, "rootDir": "src"}, "include": ["src/core/**/*.ts"], "exclude": ["src/core/test/**"]}`. With `types: []` neither `@types/node` nor `@types/vscode` are visible, so `Buffer`, `process`, `__dirname` fail to compile. `lib` has no DOM, so core uses only ES globals plus these structural ambient declarations in `src/core/host/globals.d.ts`: `crypto` (`getRandomValues`, `subtle.digest`), `TextEncoder/TextDecoder`, `setTimeout/clearTimeout`, `console`, `AbortSignal`, `URL`. Tests under `src/core/test/` are type-checked by the main tsconfig (they use mocha/node).
2. `scripts/check-core-boundary.mjs`: scans `src/core/**/*.ts` (excluding `test/`) for import/require/dynamic-import specifiers matching the forbidden list, scans `src/hosts/obsidian/pure/**` for `obsidian`, scans for cross-host imports, exits 1 with `file:line`. Wired as `npm run check:core`, called by `build`, `typecheck` and `pretest`.

Considered: ESLint `no-restricted-imports` (extra dependency and config for one rule; the script is 60 lines and also catches `require`). Considered: a project reference per package (needs the monorepo ADR 0001 deferred).

pdfjs types are imported with `import type` only inside core, from `src/core/pdf/pdfjs.d.ts` (moved from `src/pdfjs.d.ts`), so core compiles without `pdfjs-dist` types in `types`.

### D2. Ports (TypeScript signatures)

`src/core/host/storage.ts`

```ts
/** Workspace-relative POSIX path ("Eddie Reviews/m/ch1/rev-1/a.review.json"), or an
 *  absolute POSIX-style path ("/Users/me/x.pdf", "C:/x.pdf") on hosts whose
 *  capabilities.absolutePaths is true. Always produced by core/host/posix.normalize. */
export type WorkspacePath = string & { readonly __brand: "WorkspacePath" };

export type StorageErrorCode = "ENOENT" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EACCES" | "EIO";
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, readonly path: string, cause?: unknown);
}

export interface DirEntry { readonly name: string; readonly isDirectory: boolean }

export interface StoragePort {
  readText(path: WorkspacePath): Promise<string>;           // UTF-8
  readBytes(path: WorkspacePath): Promise<Uint8Array>;
  writeText(path: WorkspacePath, text: string): Promise<void>;     // creates parents? NO: callers mkdirp first
  writeBytes(path: WorkspacePath, bytes: Uint8Array): Promise<void>;
  exists(path: WorkspacePath): Promise<boolean>;
  remove(path: WorkspacePath): Promise<void>;               // file or empty directory; ENOENT is not an error
  copy(from: WorkspacePath, to: WorkspacePath): Promise<void>;
  list(dir: WorkspacePath): Promise<DirEntry[]>;            // ENOENT when dir is missing
  mkdirp(dir: WorkspacePath): Promise<void>;
}
```

`src/core/host/services.ts`

```ts
export interface Settings {
  reviewFolder: string; importPdfs: boolean;
  stampOutput: "reviewFolder" | "besidePdf"; reportOutput: "reviewFolder" | "besideSource";
  matchThreshold: number; showResolved: boolean; autoAnchor: boolean; inlineMarkers: boolean;
  expandThreads: boolean; highConfidence: number;
  semanticFallback: boolean; ollamaUrl: string; embedModel: string; semanticThreshold: number;
  lexicalFallback: boolean; authorName: string; lexicalThreshold: number;
}
export const DEFAULT_SETTINGS: Readonly<Settings>;             // VS Code defaults (reviewFolder ".eddie")
export function sanitizeSettings(raw: unknown, defaults?: Readonly<Settings>): Settings; // type/clamp/enum per key

export interface SettingsPort {
  get(): Readonly<Settings>;
  readonly onDidChange: Event<ReadonlySet<keyof Settings>>;
}
export interface Notifier { info(message: string): void; warn(message: string): void }
export interface HttpPort {                                    // Ollama only; absent on mobile
  postJson(url: string, body: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }):
    Promise<{ status: number; json: unknown }>;
}
export interface HostServices {
  readonly storage: StoragePort;
  readonly settings: SettingsPort;
  readonly notify: Notifier;
  readonly capabilities: Capabilities;
  readonly http?: HttpPort;
  /** Resolve the name for replies. undefined = the user declined. Hosts memoize. */
  authorName(): Promise<string | undefined>;
  readonly pdf: PdfEngine;
  log(level: "debug" | "info" | "warn", message: string, detail?: unknown): void;
}
```

`src/core/host/capabilities.ts`

```ts
export interface Capabilities {
  absolutePaths: boolean;                       // vscode, cli: true; obsidian: false
  pdfExtract: boolean;                          // false disables map/re-map/extract commands
  pdfStamp: boolean;
  pdfWorker: "worker" | "main-thread" | "none"; // reported by the PdfEngine after probing
  maxPdfBytes?: number;                         // host-advised ceiling; checked before reading
  semanticFallback: boolean;                    // false on mobile
  nativeFilePicker: boolean;                    // desktop Obsidian, vscode, cli
  gitIdentity: boolean;                         // vscode, cli
  builtinPdfRect: boolean;                      // Obsidian viewer honours #rect= (spike result)
}
```

`src/core/host/events.ts`

```ts
export interface Disposable { dispose(): void }
export type Event<T> = (listener: (e: T) => void) => Disposable;
export class Emitter<T> { readonly event: Event<T>; fire(e: T): void; dispose(): void }  // listener errors are caught and logged
```

`src/core/host/hash.ts`: `sha256Hex(bytes: Uint8Array): Promise<string>` (uses `globalThis.crypto.subtle.digest` when present, else the pure implementation) and `sha256HexSync(text: string): string` over UTF-8 (pure, from `src/core/host/sha256.ts`, about 70 lines, used for block fingerprints, marker ids and embed-cache keys where the call sites are synchronous). Both must equal `createHash("sha256")` output; golden vectors are in tests. The CLI host sets `globalThis.crypto ??= require("node:crypto").webcrypto` at startup (Node 18 has no global `crypto`); the VS Code extension host (Node 18+/20) does the same.

`src/core/host/random.ts`: `randomHex(bytes: number): string` over `crypto.getRandomValues`.

`src/core/host/progress.ts`: `interface Progress { onProgress?(done: number, total: number, label?: string): void; signal?: AbortSignal }` and `yieldToUi(): Promise<void>` (`setTimeout(0)`, or `MessageChannel` when present). Extraction and stamping take a `Progress` and call `yieldToUi()` every page (every N pages when a page took under 2 ms).

`src/core/pdf/engine.ts`

```ts
export interface PdfEngine {
  getDocument(params: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<PdfDocumentProxy> };
  readonly workerMode: "worker" | "main-thread" | "none";
}
export interface PdfDocumentProxy { numPages: number; getPage(n: number): Promise<PdfPageProxy>; destroy(): Promise<void> }
```

`src/core/pdf/extract.ts` stops importing pdfjs; it receives the engine (`readPages(data, engine, progress)`, `extractAnnotations(data, engine, progress)`). `polyfill.ts` moves to core (pure) and is imported by each host's engine module before pdfjs.

`src/core/host/posix.ts`: `normalize`, `join`, `dirname`, `basename(p, ext?)`, `extname`, `relative(from, to)`, `isAbsolute` (`/x`, `C:/x`, `//unc`), `toWorkspacePath(p: string): WorkspacePath` (converts `\` to `/`, normalizes, strips trailing `/`). The root of a relative-path workspace is the empty string, so `relative("", "a/b")` is `a/b`.

`src/core/host/memoryStorage.ts`: `MemoryStorage implements StoragePort` over a `Map<string, Uint8Array|"dir">`, plus `memoryHost(overrides?)` building a `HostServices` that records notices (replacing what `scripts/vscode-stub.cjs` records in `shown`).

### D3. Path identity

- Core path ids are `WorkspacePath` strings, normalized once at the boundary (`toWorkspacePath`) and never re-resolved. Equality is string equality of normalized forms (replaces `samePath`/`path.resolve`).
- Obsidian: id equals the vault-relative path (`Eddie Reviews/m/ch1/rev-1/a.review.json`); `LayoutConfig.workspaceRoot = ""`. `adapter.*` calls receive the id unchanged, so there is no mapping layer to get wrong; `normalizePath` from `obsidian` is applied by the host on the way in (it also collapses `//` and strips leading `/`).
- VS Code and CLI: ids are absolute POSIX-style paths (`/Users/me/p/m.adoc`, `C:/Users/me/p/m.adoc`), exactly what `path.resolve` produced before, with `\` converted. `LayoutConfig.workspaceRoot` stays the absolute folder. The host `StoragePort` converts an id to `vscode.Uri.file(id)` / a native path. This keeps today's layouts and every existing sidecar relative path byte-identical.
- Sidecar-internal paths remain relative to the sidecar directory with `/` separators (`FORMAT.md`); `core/model/format.ts` computes them with `posix.relative` and resolves them with `posix.join`/`normalize` (was `path.relative`/`path.resolve` plus a backslash conversion).
- Case: ids are case-preserving and compared case-sensitively. macOS and Windows vaults are case-insensitive on disk; two spellings of one file would be two sessions. Accepted (Obsidian itself normalizes link casing for existing files); see Risks.

### D4. Async migration of `ReviewStore`

Rules: (a) in-memory reads (`get`, `sessionsFor`, ...) stay synchronous because the UI calls them while rendering; (b) everything that touches storage returns a `Promise`; (c) a mutator changes memory first, fires `onDidChange` immediately (UI stays responsive), then persists; its promise resolves after the write; (d) persists are serialized per sidecar through a promise-chain lock (`private locks = new Map<WorkspacePath, Promise<unknown>>`) so two quick mutations cannot interleave writes and the last write holds both; (e) a failed write calls `notify.warn` and resolves `false`/void exactly as the old `persist` swallowed errors into a warning (extraction and "not loaded" errors still throw). The constructor becomes `new ReviewStore(host: HostServices, opts?: { embedCachePath?: WorkspacePath })`; `settings.get()` replaces `vscode.workspace.getConfiguration("eddieDoc")` in `runFallbacks`, and `configure(layout)` is derived from settings by the host and still pushed in.

| Method (today, `src/model/store.ts`) | After (`src/core/model/store.ts`) | Notes |
| --- | --- | --- |
| `constructor()` | `constructor(host: HostServices, opts?)` | emitter is core `Emitter<WorkspacePath \| undefined>` |
| `useEmbedCacheFile(file)` | removed; `opts.embedCachePath` | `FileEmbedCache` takes a `StoragePort` + path (async load/flush) |
| `configure(layout)` / `layoutConfig` | same, sync | pure state |
| `get`, `getBySidecar`, `all`, `sessionsFor`, `revisionsFor`, `latestRevision`, `nextRevision`, `documents`, `locate`, `findItem` | same, sync | keys are normalized `WorkspacePath` |
| `setActive(sidecar)` | same, sync | fires event |
| `tryLoadSidecar(adoc)` | `Promise<ReviewSession \| undefined>` | `legacySidecarPath`, `discoverSidecars` use `exists`/`list` |
| `discoverSidecars` (private) | async, `list()` based | `readDirSafe`/`isDir` become `list` + `isDirectory` |
| `loadSidecarFile(sidecar, adoc?)` | `Promise<ReviewSession \| undefined>` | `readText`; bound source checked with `exists` |
| `loadReview(adoc, pdf, opts)` | same async, new optional `progress` | `readBytes` x2; `sha256Hex(bytes)` before extraction (ordering bug stays unrepresentable); `importPdf` async |
| `mintMappingId`, `sidecarPathFor` | same, sync | pure over layout |
| `importPdf` (private) | `Promise<WorkspacePath \| undefined>` | `mkdirp` + `copy`; warns via `notify` |
| `appendPdf(sidecar, pdf, opts)` | same async, new optional `progress` | |
| `mergeMappings(target, others)` | `Promise<MergeOutcome & {removed, failed}>` | `remove` per other sidecar, target written first |
| `remap(adoc, threshold)` | same async | |
| `remapAll(adoc, threshold, opts)` | same async | one event per document |
| `remapSession` (private) | async | `readBytes` of source, `sha256Hex` |
| `warnNewlyStale`, semantic warning | via `host.notify.warn` | |
| `runFallbacks` (private) | async, reads `host.settings.get()` | Ollama via `host.http` only if `capabilities.semanticFallback` |
| `describeMapping`, `recordArtifact` | `Promise<void>` | siblings persisted sequentially |
| `deleteMapping(sidecar)` | `Promise<boolean>` | `remove` |
| `planMigration()` | same, sync | pure over layout and sessions |
| `migrate(steps)` | `Promise<{moved, failed}>` | `mkdirp`, `writeText`, `remove` |
| `shiftPositions(adoc, changes)` | same, sync, in-memory | called per keystroke; MUST stay sync and cheap |
| `toggleResolved`, `relink`, `addReply`, `editReply`, `deleteReply`, `confirmMatch` | `Promise<void>` | memory, event, then persist (D4 c) |
| `addReply(adoc, id, author, body)` | `Promise<void>` | reply id from `randomHex(4)` with `r-` prefix |
| `remapItem(adoc, id, threshold)` | `Promise<void>` | source read via `readText` |
| `buildAnchors(adoc, source)` | same, sync | pure; returns rewritten source, host applies it as one editor transaction |
| `touch`, `number` (private) | `touch` async; `number` sync | |
| `persist` (private) | `Promise<boolean>` | `mkdirp(dirname)` + `writeText(serialize(...))`, serialized by the lock, with the stamp check below |
| `dispose()` | same | |
| new `reloadFromDisk(sidecar)` | `Promise<boolean>` | for host file watchers and the staleness check |

Concurrent-host safety (spec `review-sidecar-interop`): each session keeps `diskStamp` (the SHA-256 of the text last read or written). `persist` re-reads the file first when it exists; if its hash differs from `diskStamp`, the store re-parses the disk version, re-applies the pending mutation (every mutator is an `(item, ...args) => void` operation on an item id, so it can be replayed on the fresh copy), warns once ("changed elsewhere, merged"), and then writes. Bulk operations (`remapAll`) replay by simply re-deriving from the fresh state. This costs one extra read per write and removes silent overwrite.

Call-site migration (VS Code): every `store.x(...)` call in `src/extension.ts` gains `await`; command handlers are already `async`. `ui/comments.ts` reply handlers and `codeActions` are the other call sites.

### D5. Event model

Core `Emitter` replaces `vscode.EventEmitter` and has the same contract (`Event<WorkspacePath | undefined>`, undefined means broad refresh). Hosts translate: VS Code subscribes in `activate` and calls its `refreshUI`; Obsidian's `ReviewController` subscribes once, coalesces with `requestAnimationFrame` (and a 50 ms trailing timer on mobile), and fans out to the view, editors and status bar. Settings changes arrive as `SettingsPort.onDidChange(keys)`: `reviewFolder` triggers `configure()` and `loadWorkspaceSidecars`, `expandThreads` is VS Code-only, display keys trigger a refresh.

### D6. Module move map (every file under `src/`)

Legend: M = moved unchanged (imports adjusted), R = moved and rewritten for ports, S = split.

| Old path | New path | |
| --- | --- | --- |
| `src/extension.ts` | `src/hosts/vscode/extension.ts` (activation, wiring) + `commands.ts`, `flows/*.ts` (openReview, appendPdfs, mergeMappings, relink, triage, stamp, anchors, applyAllEdits), `settings.ts` | S, R |
| `src/cli.ts` | `src/hosts/cli/main.ts`, `src/hosts/cli/nodeHost.ts` (NodeStorage, services, node PdfEngine) | R |
| `src/benchmark/main.ts` | `src/hosts/cli/bench.ts` | R |
| `src/benchmark/score.ts` | `src/core/benchmark/score.ts` | M |
| `src/matching/align.ts` | `src/core/matching/align.ts` | M |
| `src/matching/fuzzyMatch.ts` | `src/core/matching/fuzzyMatch.ts` | M |
| `src/matching/lexical.ts` | `src/core/matching/lexical.ts` | M |
| `src/matching/mapper.ts` | `src/core/matching/mapper.ts` | M |
| `src/matching/normalize.ts` | `src/core/matching/normalize.ts` | M |
| `src/matching/posTrack.ts` | `src/core/matching/posTrack.ts` | M |
| `src/matching/semantic.ts` | `src/core/matching/semantic.ts` (`FileEmbedCache` over `StoragePort`; `fetch` replaced by `HttpPort`; `createHash` replaced by `sha256HexSync`) | R |
| `src/model/combine.ts` | `src/core/model/combine.ts` | M |
| `src/model/format.ts` | `src/core/model/format.ts` (`sha256` becomes async `sha256Hex` re-export; `path` becomes `posix`) | R |
| `src/model/layout.ts` | `src/core/model/layout.ts` (`path` becomes `posix`; `DEFAULT_REVIEW_FOLDER` stays `.eddie`) | R |
| `src/model/numbering.ts` | `src/core/model/numbering.ts` | M |
| `src/model/refs.ts` | `src/core/model/refs.ts` | M |
| `src/model/report.ts` | `src/core/model/report.ts` (`isSessionStale` becomes async over `StoragePort`) | R |
| `src/model/store.ts` | `src/core/model/store.ts` (D4) | R |
| `src/model/types.ts` | `src/core/model/types.ts` | M |
| `src/pdf/anchor.ts` | `src/core/pdf/anchor.ts` | M |
| `src/pdf/extract.ts` | `src/core/pdf/extract.ts` (engine injected, progress, no `path`) | R |
| `src/pdf/locate.ts` | `src/core/pdf/locate.ts` | M |
| `src/pdf/polyfill.ts` | `src/core/pdf/polyfill.ts` | M |
| `src/pdf/stamp.ts` | `src/core/pdf/stamp.ts` (progress per page; bytes in and out) | R |
| `src/pdf/toAdoc.ts` | `src/core/pdf/toAdoc.ts` (`extractedAdocPath` over `posix`) | R |
| `src/pdfjs.d.ts` | `src/core/pdf/pdfjs.d.ts` | M |
| `src/source/markers.ts` | `src/core/source/markers.ts` (`sha256HexSync`) | R |
| `src/ui/threadModel.ts` | `src/core/thread/threadModel.ts` | M |
| `src/ui/precise.ts` | `src/core/source/precise.ts` (pure line/char spans returned as plain objects) + `src/hosts/vscode/precise.ts` (converts to `vscode.Range`) | S |
| `src/ui/decorations.ts` | `src/hosts/vscode/decorations.ts`; its grouping/hover-text logic extracted to `src/core/view/annotationView.ts` | S |
| `src/ui/diagnostics.ts` | `src/hosts/vscode/diagnostics.ts` | M (uses `core/view`) |
| `src/ui/codeActions.ts` | `src/hosts/vscode/codeActions.ts`; availability rules extracted to `src/core/view/actions.ts` (`availableActions(item): ActionId[]`) | S |
| `src/ui/comments.ts` | `src/hosts/vscode/comments.ts` | M |
| `src/ui/pdfPreview.ts` | `src/hosts/vscode/pdfPreview.ts` (`fs` becomes `StoragePort.readBytes`) | R |
| `src/ui/treeProvider.ts` | `src/hosts/vscode/treeProvider.ts`; status/group classification extracted to `src/core/view/annotationView.ts` | S |
| `src/util.ts` | `src/core/source/adocPath.ts` (`isAdocPath`) + `src/hosts/vscode/util.ts` (`isAdocDoc`) | S |
| `src/test/*.test.ts` (22 files: align, anchor, benchScore, combine, format, fuzzyMatch, layout, lexical, locate, mapper, markers, normalize, numbering, posTrack, refs, replies, report, rounds, semantic, stamp, store, threadModel) | `src/core/test/*.test.ts` | M; `store`, `rounds`, `replies`, `report`, `semantic` are rewritten to use `MemoryStorage`/`memoryHost` |

New under `src/core/`: `host/{storage,services,capabilities,events,posix,hash,sha256,random,progress,http,memoryStorage,globals.d}.ts`, `pdf/engine.ts`, `pdf/pageGeometry.ts` (page `view` and `rotate` for preview), `view/{annotationView,filters,spans,actions}.ts`.

New under `src/hosts/vscode/`: `vscodeHost.ts` (`VsCodeStorage` over `vscode.workspace.fs`, `VsCodeSettings`, notifier, `authorName` via `git config`), `pdfEngine.ts` (legacy build, Node worker path as today).

New under `src/hosts/obsidian/` (see D8): `main.ts`, `obsidianHost.ts`, `storage.ts`, `settings.ts`, `settingsTab.ts`, `capabilities.ts`, `commands.ts`, `controller.ts`, `adoc/{claim,attach}.ts`, `view/ReviewView.ts` (+ `view/*.ts` components), `editor/{extension,decorations,gutter,hover,changes}.ts`, `preview/{pdfLink,ownPdfView}.ts`, `modals/*.ts`, `pdf/{engine,workerEntry}.ts`, `styles.css`, `manifest.json`, and `pure/*.ts` for logic that must stay importable without `obsidian` (`claimDecision`, `markupModel`, `pdfRect`, `settingsMap`, `pathMap`, `filters`).

New repo-level: `tsconfig.core.json`, `scripts/check-core-boundary.mjs`, `scripts/obsidian-stub.cjs`, `scripts/build-obsidian.mjs` (or entries inside `esbuild.js`), `versions.json`, `spikes/obsidian-mobile/` (throwaway).

### D7. VS Code and CLI adapters

- `VsCodeStorage` implements `StoragePort` with `vscode.workspace.fs` (`readFile`, `writeFile`, `stat`, `delete`, `copy`, `readDirectory`, `createDirectory`; the last is recursive). Ids are absolute, so `Uri.file(id)`; remote workspaces keep working because the id resolves through the workspace FS provider (this is a small improvement over `node:fs`).
- Settings: `VsCodeSettings` reads `workspace.getConfiguration("eddieDoc")` through `sanitizeSettings` and forwards `onDidChangeConfiguration`.
- `authorName()`: setting, else memoized `execFileSync("git", ["config","user.name"])`, else `"Author"` (moved from `extension.ts:2396`; `capabilities.gitIdentity` true).
- CLI: `NodeStorage` over `node:fs/promises`; the CLI keeps its `STDOUT_GUARD` banner, flags and exit codes. Existing CLI flows (`--json`, stamp, report) call core functions with a `memory`-free `NodeHost`.
- Behaviour parity gate: before each host step, a golden test maps `sample/` fixtures through the old and new code and diffs the sidecar JSON.

### D8. Obsidian host architecture

**Plugin shell** (`main.ts`, `class EddiePlugin extends Plugin`): `onload` loads data (`sanitizeSettings`), builds `ObsidianHost` (storage, settings, notices via `Notice`, capabilities, pdf engine), creates the `ReviewStore`, registers view type `eddie-review`, commands, settings tab, ribbon icon, editor extension, vault and workspace events, then waits for `app.workspace.onLayoutReady` to run `.adoc` claiming/attaching and `loadWorkspaceSidecars`. Everything is registered through `registerEvent`/`registerDomEvent`/`register` so unload is clean.

**Storage** (`storage.ts`): `ObsidianStorage implements StoragePort` over `app.vault` and `app.vault.adapter`. Reads use `vault.read(TFile)` when the path is indexed, else `adapter.read`; writes use `vault.modify`/`vault.create`/`createBinary`/`modifyBinary` for indexed or creatable visible paths so the metadata cache, other plugins and Sync see the change, and `adapter.write*` only for non-indexed locations (the plugin data directory, a user-chosen dot folder). `mkdirp` walks segments with `adapter.exists` + `adapter.mkdir` (recursive mkdir is not guaranteed on the Capacitor adapter). `list` maps `adapter.list` (full paths) to names. Errors are mapped to `StorageError` codes. No Node: only `obsidian` APIs.

**Review panel** (`view/ReviewView.ts`, `ItemView`, `getViewType() = "eddie-review"`, `getIcon() = "message-square"`): header (document, round and mapping switchers, counts, panel menu); filter bar; list; thread; action bar. Rendering uses the DOM helpers (`createEl`, `Setting` not used here) and plain re-render with keyed rows (`data-id`), preserving the reply `<textarea>` value, focus and scroll between refreshes. Pure parts (rows, status classification, filter application, counts) are in `core/view/{annotationView,filters}.ts`; thread header, root markdown and `threadSignature` are the existing `core/thread/threadModel.ts` (`threadLabel`, `rootMarkdown`, `markAuthor`), so a thread re-renders only when `threadSignature` changes. Root markdown renders through `MarkdownRenderer.render` (the text is the Reviewer's quote and note, not AsciiDoc). Actions: `availableActions(item)` (core) decides which buttons are enabled. Narrow viewports (`Platform.isMobile` or container width under 520 px) switch to list/detail stacking with a back button; row and button minimum height 44 px via `styles.css`.

**Editor markup** (`editor/*`): see D9. **Preview**: D11. **Commands**: spec `obsidian-commands`; handlers live in `commands.ts` and call the same flows the panel buttons call (`flows` are plain async functions taking `(plugin, ctx)`), using `checkCallback` so context-less commands are not offered.

**Modals** (`modals/*`): `PdfSuggestModal extends FuzzySuggestModal<TFile>` over `vault.getFiles().filter(f => f.extension === "pdf")` sorted by `mtime` desc; `PromptModal` (text, replaces `showInputBox`), `ChoiceModal` (`SuggestModal`, replaces `showQuickPick`), `ConfirmModal`. Desktop-only outside-vault import: an `<input type="file" accept=".pdf">` created on demand, read via `File.arrayBuffer()`, written into `<reviewFolder>/.../rev-N/pdf/` through the storage port; shown only when `capabilities.nativeFilePicker`. Electron `remote` or `dialog` are not used.

**Status bar** (desktop): `plugin.addStatusBarItem()` (not available on mobile; `Platform.isMobile` guard) showing `source ⇄ pdf`; click opens the review switcher. On mobile the same string is the panel header.

**Vault events**: `vault.on("modify")` for a source with sessions schedules `store.remapAll(..., {onlyIfSourceChanged: true})` after 1500 ms of quiet (Obsidian autosaves on a ~2 s debounce, so "on save" is "after the file changes on disk"); `vault.on("modify" | "create" | "delete")` for paths under `reviewFolder` ending `.review.json` calls `store.reloadFromDisk` (sync or another host rewrote it) when the hash differs from `diskStamp`; `vault.on("rename")` for a source or sidecar re-keys the session and rewrites the sidecar's relative paths (`store.rebindPaths(old, new)`, new, core). Event handlers ignore the plugin's own writes by comparing `diskStamp`.

### D9. CodeMirror 6 integration

Extensions are built from `@codemirror/state` and `@codemirror/view` as provided by Obsidian (marked external; bundling a second copy breaks `instanceof` checks, `StateField` identity and facet resolution).

```ts
// editor/extension.ts
export const setMarkup = StateEffect.define<MarkupModel>();          // pushed by the controller
export const markupField = StateField.define<MarkupState>({           // model + DecorationSet
  create: () => emptyMarkup(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkup)) return buildMarkup(e.value, tr.state.doc, settings);
    return tr.docChanged ? value.map(tr.changes) : value;             // visual live tracking between pushes
  },
  provide: f => [EditorView.decorations.from(f, v => v.deco)],
});
export function eddieExtensions(host): Extension[] {
  return [markupField, annotationGutter(host), annotationHover(host), changeBridge(host), editorMenuHook(host)];
}
```

- Line highlights: `Decoration.line({ class: "eddie-line eddie-open" | "eddie-resolved" })` per covered line, built by `pure/markupModel.ts` from `core/view/annotationView.ts` spans (`effectiveLine` and `match.endLine`, clamped to `doc.lines`, 0-based to 1-based).
- Gutter: `gutter({ class: "eddie-gutter", lineMarker(view, line) {...}, domEventHandlers: { click } })` with a `GutterMarker` subclass rendering the remark number (and a count when several start on a line); click calls `controller.select(id)`.
- Hover: `hoverTooltip((view, pos) => ...)` on desktop; on mobile, a `domEventHandlers` long-press (`contextmenu`/touch timer) shows the same content in a `Notice`-less popover element.
- Inline end-of-line markers (`inlineMarkers`): `Decoration.widget({ widget: new KindWidget(kind), side: 1 })` at line end. It is a widget decoration, never document text, so nothing is saved to the file (spec).
- Live edits to core: `EditorView.updateListener.of(u => { if (!u.docChanged) return; const changes: ContentChange[] = []; u.changes.iterChanges((fromA, toA, _fb, _tb, ins) => changes.push({ startLine: u.startState.doc.lineAt(fromA).number - 1, endLine: u.startState.doc.lineAt(toA).number - 1, newLineCount: ins.lines - 1 })); controller.onEdit(path, changes) })`. `ContentChange` is the existing shape in `src/matching/posTrack.ts` (`startLine`, `endLine`, `newLineCount`, same fields `extension.ts:357-361` builds from `contentChanges`). `iterChanges` yields ranges in ascending document order in start-doc coordinates, which is the same convention as VS Code's `contentChanges` per event; `shiftLine` is applied per change as today. `store.shiftPositions` runs synchronously; the controller then schedules a redraw after `LIVE_QUIET_MS` as in `extension.ts`.
- Attaching: for views Obsidian creates itself (`MarkdownView`, including claimed `.adoc`), `plugin.registerEditorExtension(eddieExtensions(host))` with a per-editor guard `editorInfoField` -> `file.path` (extension is a no-op for files without a mapping). For editors owned by another plugin's view, the host reaches the CM6 `EditorView` (for a `MarkdownView`-derived view `view.editor.cm`; for a custom view, `view.cm ?? view.editor?.cm ?? view.editorView`, guarded) and appends the extensions inside a `Compartment` with `StateEffect.appendConfig`; detach is `compartment.reconfigure([])`. A `layout-change` / `active-leaf-change` / `file-open` listener re-scans leaves and attaches idempotently (a `WeakSet<EditorView>` records attached editors).
- Menu: `workspace.on("editor-menu", (menu, editor, view) => ...)` adds items when `editor.getCursor().line` lies in an annotated span.

### D10. `.adoc` claiming algorithm (ADR 0002, `obsidian-adoc-files`)

Run in `onLayoutReady` (all community plugins have loaded, so ordering does not make us steal an extension that a later-loading plugin would have registered):

```
EXTS = ["adoc", "asciidoc"]
claimed = []
for ext in EXTS:
  holder = holderOf(app, ext)
  # holderOf: reads app.viewRegistry.typeByExtension[ext] ?? app.viewRegistry.getTypeByExtension?.(ext)
  #   returns a view-type string | undefined (nobody) | UNKNOWN (registry shape not recognised)
  match decideClaim(holder, settings.claimAdoc):          # pure/claimDecision.ts
    "claim":  try plugin.registerExtensions([ext], "markdown"); claimed.push(ext)
              catch (e) -> treat as held by other (Obsidian throws if the extension is registered)
    "skip-held":  held.push(ext)
    "skip-unknown": log "could not verify"; held.push(ext)
    "skip-setting": (claimAdoc == "never")
if held.length: once-per-vault Notice("Eddie Doc: <ext> is handled by <viewType>; using attach mode") + log
for leaf of claimed-extension leaves already open: force source mode
register active-leaf-change / file-open: if file.extension in claimed: ensure source mode
stage 2: attachToForeignEditors(held)      # D9 "Attaching"
```

`decideClaim`: `holder === undefined` and setting `auto` gives `claim`; `holder` defined gives `skip-held`; unknown registry gives `skip-unknown`; setting `never` gives `skip-setting`. It is a pure function with a truth-table unit test. Claim means registering the markdown view type for the extension, so Obsidian opens `.adoc` in `MarkdownView`. Forcing source mode: `leaf.setViewState({ type: "markdown", state: { file, mode: "source", source: true } })` (`source: true` selects source mode as opposed to Live Preview); if the view is toggled to `preview`, the `active-leaf-change` handler flips it back. A CSS scope class `eddie-adoc` (added to the leaf container by the `markdownView` editor extension, which sets `EditorView.editorAttributes`) resets markdown heading, bold and list styling so `== Heading` is not styled as markdown. Unload releases the claim with `Plugin` auto-unregistration (registered extensions are removed when the plugin unloads). Stage 2 is tested against AsciiDoc Live first; if its view does not expose a CM6 editor the host logs `attach: no editor` and the panel remains fully usable. A plugin setting `claimAdoc: "auto" | "never"` (Obsidian only, default `auto`) is the escape hatch for users who enable another AsciiDoc plugin after Eddie has claimed the extension. Source extension set for reviews is `adoc|asciidoc|asc|ad` (`isAdocPath`), regardless of who opens them.

### D11. PDF preview in Obsidian

Primary: `workspace.openLinkText(link, sourcePath, "split")` with `link = "<vault path of PDF>#page=N&rect=l,b,r,t"`. Obsidian's built-in viewer parses `#page=` and `&selection=`; `&rect=` (a rectangular highlight in PDF coordinates) is documented by the PDF++ plugin and **may not be honoured by the stock viewer**. This is an **assumption to be verified in the spike (task 0.4)**, on desktop and on mobile, with and without PDF++ installed. Fallback ladder, selected through `capabilities.builtinPdfRect` and a per-platform spike result:

1. `builtinPdfRect === true`: `#page=N&rect=...` as above.
2. else: own `ItemView` (`eddie-pdf-preview`, `preview/ownPdfView.ts`) rendering the page with the pdfjs browser engine already in the bundle (`page.render` onto a canvas at device-pixel-ratio scale) with an absolutely positioned overlay `div` for the rectangle; scrolls and re-renders on selection. Memory: one canvas, destroyed when the page changes; on mobile the render scale is capped.
3. Last resort: `#page=N` only plus a Notice, never failing silently.

**Coordinate conversion** (`pure/pdfRect.ts`, unit-tested). The sidecar stores `rect = [x0, y0, x1, y1]` in PDF user space, in points, bottom-left origin, as given to `RawAnnotation.rect` by `src/pdf/extract.ts`. Steps:

1. Normalize: `l = min(x0,x1)`, `b = min(y0,y1)`, `r = max(x0,x1)`, `t = max(y0,y1)`; drop the rect (page-only link) if `r-l < 0.5 || t-b < 0.5`.
2. Read page geometry once per PDF and page with `core/pdf/pageGeometry.ts` (`view = [vx0,vy0,vx1,vy1]`, `rotate`), cached in memory. The sidecar does not record rotation.
3. For `mode = "pdf-user"` (assumed if the viewer follows PDF++ semantics: user-space, bottom-left, unrotated page): clamp to `view`; emit `l,b,r,t`. For rotated pages (`rotate` 90/180/270) the viewer is assumed to expect unrotated user space too, so no change.
4. For `mode = "viewport-top-left"` (chosen by the spike if the viewer reports `rect` in unrotated top-left page coordinates at scale 1): `H = vy1 - vy0`; `left = l - vx0`, `right = r - vx0`, `top = vy1 - t`, `bottom = vy1 - b`; emit `left,top,right,bottom`.
5. The own-view overlay uses the pdfjs viewport transform (`viewport.convertToViewportRectangle([l,b,r,t])`) which already handles origin and rotation.

Which of 3 or 4 applies, and whether the rotation case needs a transform, is a spike output recorded in `capabilities.ts` (`rectMode`). Whether `extract.ts` already normalizes rects for rotated pages is to be confirmed by reading `itemBox`/annotation handling in task 1.x tests and adding a rotated-page fixture.

"Follow selection": `ReviewView` calls `preview.show(...)` with `active: false` semantics (open with `{ active: false }` leaf options and `revealLeaf` not called) so keyboard focus stays in the list. A missing PDF falls back to a notice with a `PdfSuggestModal` to re-locate (updates `pdf.path` after confirmation).

### D12. Settings mapping

Core `Settings`/`sanitizeSettings` own types, clamps and enums, so both hosts agree. `package.json` `contributes.configuration` stays for VS Code. The Obsidian tab is a `PluginSettingTab` built from a descriptor table in `settingsTab.ts`; values persist in `data.json` through `plugin.saveData`.

| Key | VS Code default | Obsidian default | Control | Notes |
| --- | --- | --- | --- | --- |
| `reviewFolder` | `.eddie` | `Eddie Reviews` | text | Obsidian: vault-relative only; dot prefix warns; absolute rejected |
| `importPdfs` | `false` | `true`, forced | read-only toggle | Obsidian cannot read PDFs outside the vault on mobile; outside-vault PDFs are copied in |
| `stampOutput` | `reviewFolder` | same | dropdown | `reviewFolder` or `besidePdf` |
| `reportOutput` | `reviewFolder` | same | dropdown | `reviewFolder` or `besideSource` |
| `matchThreshold` | `0.5` | same | slider 0 to 1 | |
| `showResolved` | `true` | same | toggle | |
| `autoAnchor` | `true` | same | toggle | writes `// eddie:<id>` markers at map time |
| `inlineMarkers` | `true` | same | toggle | CM6 widget decoration |
| `expandThreads` | `false` | same | toggle | Obsidian: panel opens the thread of the first unanswered annotation on load |
| `highConfidence` | `0.75` | same | slider 0 to 1 | |
| `semanticFallback` | `false` | `false` | toggle | desktop-only, hidden on mobile |
| `ollamaUrl` | `http://localhost:11434` | same | text | desktop-only; `requestUrl` |
| `embedModel` | `embeddinggemma` | same | text | desktop-only |
| `semanticThreshold` | `0.62` | same | slider 0 to 1 | desktop-only |
| `lexicalFallback` | `true` | same | toggle | |
| `authorName` | `""` (git `user.name`) | `""` (prompt once) | text | no `git` on mobile; `set-author-name` command |
| `lexicalThreshold` | `0.6` | same | slider 0 to 1 | |
| `claimAdoc` (Obsidian only) | n/a | `auto` | dropdown `auto`/`never` | escape hatch, D10 |
| `panelFilters` (Obsidian state, not a setting UI) | n/a | `{}` | none | persisted view state in `data.json`, never in sidecars |

`pure/settingsMap.ts` converts the stored object to `Settings` and back (`sanitizeSettings` with Obsidian defaults), unit-tested for clamping and the corrupt-value scenario.

### D13. Mobile constraints, capability flags and spike protocol

Constraints: no Node, no Electron, no `child_process`; vault IO only through `app.vault`/`adapter`; WebView memory and CPU budgets; iOS lacks `Promise.withResolvers` below Safari 17.4 (hence the retained `polyfill.ts`), may reject blob workers or large transfers; background tabs are suspended, so long operations must be resumable-by-redo (nothing is written until the end) and cancellable.

Engine strategy: pdfjs browser build; worker bundled as a classic IIFE string (`workerEntry.ts` sets `globalThis.pdfjsWorker = { WorkerMessageHandler }`), started as `new Worker(URL.createObjectURL(new Blob([src])))` and handed to pdfjs through `GlobalWorkerOptions.workerPort`; if `new Worker` throws or the worker does not answer a probe within 3 s, the same source is evaluated on the main thread so pdfjs uses its fake-worker path, and `workerMode = "main-thread"`. Page-by-page extraction with `yieldToUi()` and `page.cleanup()` after each page; no canvas is created during extraction; PDF bytes are read once, hashed first, and copied for pdfjs (the existing detach-protection in `loadDocument`).

Spike protocol (`spikes/obsidian-mobile/`, a throwaway plugin that imports the real core and engine modules, run before any other Obsidian work):

1. Fixture: a ~300-page PDF built from a synthetic manuscript with about 200 annotations of every kind (highlight, strikeout, underline, text, caret, free-text), plus a rotated-page document and a 40 MB scanned-style PDF. Put them and a matching `.adoc` in a test vault synced to the phone.
2. Devices: one iPhone (iOS 17 or later) and one mid-range Android; plus desktop macOS as the baseline.
3. For each operation measure on each device, three runs: extract, map (extract plus match plus write), re-map, stamp, export report, extract-as-adoc, preview with `#page=N&rect=...`, `&selection=`, `&offset=`, and the own view. Record: success, wall time, longest UI stall (frame gap measured with a 100 ms `setInterval` drift probe), crash/kill, memory warning, worker mode, and output equality with desktop (same item ids and positions).
4. Pass criteria: no crash; map under 120 s for 300 pages; longest stall under 1 s with yielding on; identical items to desktop. Anything else sets the matching `Capabilities` flag false by default for that platform and creates a follow-up task; failing `pdfWorker` falls back as above before being declared failed.
5. Write the results table into `docs/obsidian-spike-results.md` (task 0.6) and set defaults in `hosts/obsidian/capabilities.ts` (`pdfExtract`, `pdfStamp`, `pdfWorker`, `maxPdfBytes`, `builtinPdfRect`, `rectMode`).

Capability probing at runtime: `capabilities.ts` combines static platform defaults from the spike (`Platform.isMobile`, `Platform.isIosApp`, `Platform.isAndroidApp`) with a one-time worker probe stored in memory (not persisted); commands consult `capabilities` through `checkCallback`, and the panel shows a "not available on this device" explanation instead of hiding silently.

### D14. Build and bundling

`esbuild.js` becomes a table of builds:

| Build | Entry | Out | Platform/format | External | Notes |
| --- | --- | --- | --- | --- | --- |
| vscode | `src/hosts/vscode/extension.ts` | `dist/extension.js` | node, cjs, node18 | `vscode` | as today; pdfjs legacy build; copies `pdf.worker.mjs`, `pdf.min.mjs`, `pdf.worker.min.mjs` as today |
| cli | `src/hosts/cli/main.ts` | `dist/cli.js` | node, cjs | none | stdout guard banner |
| bench | `src/hosts/cli/bench.ts` | `dist/bench.js` | node, cjs | none | stdout guard banner |
| obsidian | `src/hosts/obsidian/main.ts` | `dist/obsidian/main.js` | browser, cjs, es2020 | `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins (a build assertion fails if any appears in the output) | `define: { "process.env.NODE_ENV": '"production"', global: "globalThis" }`; minify in production; sourcemap inline only in watch |
| obsidian worker | `src/hosts/obsidian/pdf/workerEntry.ts` | in-memory | browser, iife, es2020 | none | built first by a plugin that exposes the minified output as the string module `virtual:pdf-worker-source`; pdfjs `pdf.worker.min.mjs` input |

Static files: `src/hosts/obsidian/manifest.json` and `styles.css` are copied to `dist/obsidian/`, with `version` in the manifest rewritten from `package.json`. Aliases: none needed because core reaches pdfjs through `PdfEngine`; the Obsidian engine imports `pdfjs-dist/build/pdf.min.mjs`, the Node hosts import `pdfjs-dist/legacy/build/pdf.mjs`. pdfjs is pinned to the installed 4.x line; `polyfill.ts` is imported first in each engine module. Release bundle size is checked (warn above 4 MB). Watch mode: `OBSIDIAN_VAULT=/path npm run watch:obsidian` copies the three files into `$OBSIDIAN_VAULT/.obsidian/plugins/eddie-doc/` after each rebuild (and writes `.hotreload` if present). New scripts: `check:core`, `build:obsidian`, `watch:obsidian`, `test:core`. `.vscodeignore` excludes `dist/obsidian/**`.

### D15. Testing strategy

- Core: the 22 existing suites move to `src/core/test/` and run unchanged under mocha (`.mocharc.json` spec becomes `out/**/test/**/*.test.js`). Store-dependent suites (`store`, `rounds`, `replies`, `report`, `semantic`) switch from the `vscode` stub to `MemoryStorage`/`memoryHost`, asserting on recorded notices where they asserted on `shown`. New core tests: `posix`, `hash` golden vectors against known `createHash` outputs, `storage` contract tests run against `MemoryStorage` (and re-used for `NodeStorage` in the CLI host tests), async store behaviour (serialized writes, replay on disk change), `annotationView`/`filters`/`actions`, `progress` cancel and yield, boundary script (a fixture file that violates it).
- Parity: a golden test maps the sample fixtures with the pre-refactor outputs frozen as fixtures (`src/core/test/golden/`) and requires equal sidecar JSON apart from timestamps; run in Phase 1 after every step.
- Obsidian host pure logic runs under mocha with `scripts/obsidian-stub.cjs` (resolver hook added next to `mocha-vscode.cjs`, same pattern): `markupModel` (CM6 decoration building against a real `@codemirror/state` `EditorState`, no DOM), `pathMap`, `settingsMap`, `claimDecision` truth table, `pdfRect` conversion including rotated pages and zero-area rectangles, panel `filters`, and `changes` (ChangeSet to `ContentChange[]` via `EditorState.update` with multi-range changes). Stub classes (`Plugin`, `ItemView`, `Modal`, `Notice`, `PluginSettingTab`, `Setting`, `TFile`, `Platform`) are minimal and record calls.
- Honest limit: nothing here exercises real Obsidian (view lifecycle, `viewRegistry` shape, built-in PDF viewer, mobile WebView, blob workers, sync interplay). CI cannot run Obsidian. Verification of those is the manual QA checklist (`docs/obsidian-qa.md`, desktop macOS and Windows, iOS, Android: install via BRAT, claim and attach scenarios with and without AsciiDoc Live, map/re-map/stamp/report/export on the 300-page fixture, preview, settings changes, sync, uninstall) and the spike protocol, executed before each release.

## Risks / Trade-offs

- [pdfjs fails or exhausts memory on iOS/Android] -> spike first; page-by-page with cleanup; main-thread fallback; `Capabilities` degrade instead of fork; `maxPdfBytes` guard; legacy-build contingency (it is a browser-compatible transpile) if syntax errors appear on older WebViews.
- [Built-in viewer ignores `&rect=`] -> flagged assumption; own `ItemView` is the guaranteed path; ladder chosen by spike result.
- [`app.viewRegistry` is undocumented and may change] -> every access guarded; unknown means "treat as claimed"; registration wrapped in try/catch; `claimAdoc: "never"` setting.
- [Another plugin that loads later or is enabled later conflicts with our claim] -> claim only in `onLayoutReady`; setting to release; log and notice.
- [Obsidian autosave and `vault.modify` timing make "on save" fuzzy] -> debounce 1500 ms and `onlyIfSourceChanged`; hashing means redundant passes are no-ops.
- [Async store introduces races that the sync store could not have] -> per-sidecar lock, mutate-then-persist ordering, replay-on-conflict, tests for interleaving.
- [Case-insensitive file systems create two ids for one file] -> accepted; normalize through `normalizePath` at the Obsidian boundary; sessions are re-keyed on `rename`.
- [CM6 instance mismatch with a foreign plugin's editor] -> use Obsidian-provided modules only; guarded `instanceof EditorView`; log and fall back to panel-only.
- [Large refactor can silently change VS Code behaviour] -> golden parity test and tests-green-after-each-step rule in Phase 1; VS Code manual smoke before merging Phase 3.
- [Sync services (Obsidian Sync, iCloud) replace a sidecar mid-session] -> `diskStamp` check and `reloadFromDisk`; panel preserves reply text.
- [Bundle size (pdfjs + worker + pdf-lib) slows plugin load on mobile] -> load pdfjs lazily on first PDF operation (dynamic `import()` is bundled but evaluated late via a lazy `PdfEngine` factory); measure in spike.
- [Release-process complexity] -> a single `release.sh` extension; `versions.json` generated, not hand-edited.

## Migration Plan

1. Phase 1 extracts core with `git mv` per module and keeps `src/extension.ts` building against the moved modules (sync store still), tests green after each move.
2. Phase 2 makes the store async behind `MemoryStorage` and updates VS Code call sites; golden parity must stay green.
3. Phase 3 and 4 introduce the real VS Code and CLI adapters and move their UI/entry points.
4. Phase 5 builds Obsidian behind the spike's results.
5. Rollback: each phase is a separate PR; the VS Code extension keeps shipping from `main` throughout, and the Obsidian bundle is not published until Phase 7. If the spike fails for a whole class of device, mobile degrades by capability flags and `isDesktopOnly` stays `false` only for what the spike supports (the manifest flag is the last-resort switch).

## Open Questions

- Does AsciiDoc Live expose a CM6 `EditorView` in a way `attach.ts` can reach, and does it bundle its own `@codemirror` copy? Answered in stage 2 testing; panel-only is the fallback.
- Should the `<input type="file">` outside-vault import also be offered on mobile (it works there) rather than desktop-only? Product decision 11 says desktop-only; revisit after the spike.
- Whether the community plugin review will accept registering extensions onto the markdown view; if not, ship attach-only behind the same `claimAdoc` setting.
- Final `rectMode` (`pdf-user` or `viewport-top-left`) and rotation handling: determined by the spike (D11) and recorded in `capabilities.ts`; the spec only requires that the converted rectangle encloses the same visual region.
