## Purpose

Guarantees that one **Workspace** can be opened by VS Code, Obsidian and the CLI interchangeably because every **Host** reads and writes the same **Review sidecar** format with the same layout.

## ADDED Requirements

### Requirement: One sidecar format across hosts
Every host SHALL read and write **Review sidecars** in format version 3 as specified in `docs/FORMAT.md` and `schema/review-v3.schema.json`; the format MUST NOT change as part of this work, and files written by earlier versions (v1 to v3) SHALL still be read.

#### Scenario: Obsidian reads a VS Code sidecar
- **WHEN** a repository mapped in VS Code is opened as an Obsidian vault with `reviewFolder` set to `.eddie`
- **THEN** the mapping, its annotations and their resolution state are shown unchanged

#### Scenario: VS Code reads an Obsidian sidecar
- **WHEN** a vault mapped in Obsidian under `Eddie Reviews/` is opened in VS Code with `reviewFolder` set to `Eddie Reviews`
- **THEN** every annotation, reply and resolution made in Obsidian is present

#### Scenario: Older sidecar
- **WHEN** a v2 sidecar is loaded by the Obsidian host
- **THEN** it is read and is rewritten as v3 on the next change

### Requirement: Layout is a setting, not a format property
Review folder layout (`<reviewFolder>/<manuscript path without extension>/rev-N/<mapping>.review.json`, with imported PDFs under `rev-N/pdf/`) SHALL be identical across hosts for the same `reviewFolder` value.

#### Scenario: Same layout
- **WHEN** `manuscript/ch1.adoc` is mapped as round 1 with mapping id `acme` in each host with `reviewFolder` `Eddie Reviews`
- **THEN** the sidecar path is `Eddie Reviews/manuscript/ch1/rev-1/acme.review.json` in each

### Requirement: Portable relative paths in sidecars
Paths stored inside a sidecar SHALL be relative to the sidecar's directory with `/` separators and no absolute paths, regardless of host.

#### Scenario: Obsidian sidecar paths
- **WHEN** an Obsidian-written sidecar is inspected
- **THEN** `source.path` and `pdf.path` are relative POSIX paths that resolve correctly when the folder is cloned elsewhere

### Requirement: No host-specific data in the sidecar
Sidecars MUST NOT contain host-specific fields or editor state; host-only state (selected filters, panel layout) SHALL be stored in the host's own settings storage.

#### Scenario: Filters not persisted in sidecar
- **WHEN** the user sets panel filters in Obsidian
- **THEN** the sidecar file is not modified

### Requirement: Cross-host fixtures
The test suite SHALL contain sidecar fixtures produced by the VS Code and CLI hosts and assert that the core reads them and re-serializes them with no semantic change, so a host change that breaks interop fails a test.

#### Scenario: Round trip
- **WHEN** a fixture sidecar is parsed and serialized by the core
- **THEN** the output equals the input apart from `updatedAt` and `producer.version`

### Requirement: Concurrent hosts on one workspace
When two hosts have the same workspace open and one rewrites a sidecar, the other SHALL pick up the change the next time that mapping is loaded or its file change is observed, and SHALL NOT overwrite newer content with a stale in-memory copy without first re-reading it.

#### Scenario: Stale overwrite avoided
- **WHEN** a sidecar's content on disk changed since the host last read or wrote it and the host is about to persist a change
- **THEN** the host re-reads the file, merges the user's change into the fresh state or reports a conflict, and does not silently discard the other host's changes
