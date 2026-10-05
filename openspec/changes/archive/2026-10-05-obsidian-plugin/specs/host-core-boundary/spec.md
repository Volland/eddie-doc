## Purpose

Defines the boundary between Eddie Doc's host-neutral review logic and each **Host** (VS Code, Obsidian, CLI), and the build gate that keeps the boundary from eroding.

## ADDED Requirements

### Requirement: Host-neutral core directory
All review logic (matching, PDF reading/stamping/anchoring, the review model and layout, source markers, the thread model, and the host ports) SHALL live under `src/core/`. Each **Host** SHALL live under `src/hosts/<name>/` (`vscode`, `obsidian`, `cli`) and contain only code that adapts a host application to the core ports or renders a host-specific UI.

#### Scenario: Matching code is in the core
- **WHEN** a contributor looks for the annotation matcher, the sidecar format code or the PDF extractor
- **THEN** they are found under `src/core/` and not under any `src/hosts/` directory

#### Scenario: A host owns only adaptation and UI
- **WHEN** a file under `src/hosts/obsidian/` is reviewed
- **THEN** it either implements a core port, registers an Obsidian surface (view, command, setting, editor extension), or converts between Obsidian and core data types

### Requirement: Forbidden imports in the core
Modules under `src/core/` MUST NOT import `vscode`, `obsidian`, `electron`, or the Node built-ins `fs`, `path`, `crypto`, `child_process`, `os` or `process`-dependent APIs (with or without the `node:` prefix), and MUST NOT reference the global `process` or `Buffer`.

#### Scenario: Core file imports vscode
- **WHEN** a file under `src/core/` contains `import * as vscode from "vscode"`
- **THEN** the core boundary check fails and the build fails with the offending file and line

#### Scenario: Core file imports a Node built-in
- **WHEN** a file under `src/core/` imports `node:fs`, `fs`, `node:path`, `node:crypto` or `node:child_process`
- **THEN** the core boundary check fails and the build fails

#### Scenario: Clean core
- **WHEN** no file under `src/core/` contains a forbidden import
- **THEN** the core boundary check passes

### Requirement: Isolated type-check of the core
The repository SHALL provide a `tsconfig.core.json` that type-checks `src/core/` with no `vscode`, `obsidian` or Node type packages available (`types` empty, `lib` limited to ES2022 plus DOM-free web APIs required by the ports), so that an accidental use of a host or Node global fails compilation.

#### Scenario: Node global used in core
- **WHEN** a core file uses `Buffer.from(...)` or `process.env`
- **THEN** `tsc -p tsconfig.core.json` reports an error

#### Scenario: Gate is part of the normal build
- **WHEN** a developer runs the project build or `npm test`
- **THEN** the core type-check and the import check run as part of it and a failure stops it

### Requirement: Hosts depend on the core, never the reverse or each other
A host MUST NOT import another host, and the core MUST NOT import any host.

#### Scenario: Obsidian host imports VS Code host
- **WHEN** a file under `src/hosts/obsidian/` imports from `src/hosts/vscode/`
- **THEN** the boundary check fails

### Requirement: One package, several bundles
The repository SHALL remain a single npm package that builds each host from its own esbuild entry (`src/hosts/vscode/extension.ts`, `src/hosts/obsidian/main.ts`, `src/hosts/cli/main.ts`, `src/hosts/cli/bench.ts`), sharing one version number.

#### Scenario: Building all hosts
- **WHEN** the production build runs
- **THEN** `dist/extension.js`, `dist/cli.js`, `dist/bench.js` and `dist/obsidian/main.js` are produced from the same checkout and version

### Requirement: Core behaviour is host-independent
Given the same storage contents and settings, the core SHALL produce the same sidecar contents regardless of which host drives it.

#### Scenario: Same inputs through two hosts
- **WHEN** the same `.adoc`, PDF and settings are mapped once through the in-memory test host and once through the CLI host
- **THEN** the resulting sidecar JSON is identical apart from timestamps
