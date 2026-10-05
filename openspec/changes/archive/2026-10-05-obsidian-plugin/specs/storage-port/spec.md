## Purpose

Specifies the async storage port, path identity, host services, change events and hashing through which the core touches files and its host, and the resulting async, host-neutral review store.

## ADDED Requirements

### Requirement: Async storage port over workspace-relative POSIX paths
The core SHALL perform all file access through an async storage port offering read text, read bytes, write text, write bytes, exists, remove, copy, list a directory (returning each entry's name and whether it is a directory), and recursive create-directory. Paths passed across the port SHALL be strings relative to the **Workspace** root using `/` separators, with no leading `/`.

#### Scenario: Writing a sidecar into a new folder
- **WHEN** the core writes `Eddie Reviews/manuscript/ch1/rev-1/acme.review.json` and the parent folders do not exist
- **THEN** the folders are created and the file is written through the port without the core using any host API directly

#### Scenario: Listing a directory
- **WHEN** the core lists `Eddie Reviews/manuscript/ch1`
- **THEN** it receives one entry per child with its name and a directory flag, and no entry contains a path separator

#### Scenario: Missing file
- **WHEN** the core reads a path that does not exist
- **THEN** the port rejects with a not-found error that the core can distinguish from other I/O errors

### Requirement: Absolute-path passthrough is host-gated
A host MAY declare that absolute paths are supported (VS Code and CLI do; Obsidian does not). When it does, the core SHALL pass such a path to the port unchanged (normalized to `/` separators); when it does not, an absolute path SHALL be rejected before any I/O.

#### Scenario: VS Code maps a PDF outside the workspace
- **WHEN** a VS Code user maps `/Users/me/Downloads/ch1-marked.pdf`
- **THEN** the core reads it through the port as an absolute path

#### Scenario: Obsidian receives an absolute path
- **WHEN** a command on the Obsidian host is given an absolute filesystem path
- **THEN** the operation fails with a message explaining the file must be inside the vault, and nothing is read or written

### Requirement: Canonical path identity
Every path stored in the review session state (source, sidecar, PDF) SHALL be normalized (no `.`/`..` segments, no repeated or trailing separators, `\` converted to `/`) before use as a key, and two paths SHALL be considered the same file when their normalized forms are equal.

#### Scenario: Equivalent spellings
- **WHEN** a session is looked up with `manuscript//ch1/../ch1.adoc` after being stored under `manuscript/ch1.adoc`
- **THEN** the same session is found

### Requirement: Core path utilities
The core SHALL ship its own POSIX path utilities (normalize, join, dirname, basename, extname, relative, isAbsolute) and MUST NOT depend on Node's `path`.

#### Scenario: Relative path between sibling folders
- **WHEN** the relative path from the directory `Eddie Reviews/m/ch1/rev-1` to `manuscript/ch1.adoc` is computed
- **THEN** the result is `../../../../manuscript/ch1.adoc`

### Requirement: Host services port
The core SHALL obtain user notices (info, warning), the typed settings object with a change event, the author name, an HTTP client and the host's capability flags from a host services port, and MUST NOT call a host UI API directly.

#### Scenario: Core warns the user
- **WHEN** the review store cannot persist a sidecar
- **THEN** it calls the host's warning notice with the failure message instead of throwing a host-specific error

#### Scenario: Settings change at runtime
- **WHEN** the user changes `reviewFolder` in the host's settings UI
- **THEN** the core receives a settings-changed event with the new typed settings object

### Requirement: Host-neutral change events
The review store SHALL announce changes through a core event emitter whose listeners receive the affected source path, or nothing for a broad refresh, and SHALL NOT depend on a host's emitter type.

#### Scenario: Toggling resolved
- **WHEN** an annotation is marked resolved
- **THEN** every subscriber receives exactly one event naming the annotation's source path

#### Scenario: Re-mapping several rounds
- **WHEN** all rounds of a document are re-mapped in one pass
- **THEN** subscribers receive one event for the document, not one per round

### Requirement: Async review store
Every `ReviewStore` operation that reads or writes files, including loading sidecars, mapping, appending PDFs, merging, re-mapping, state changes, reply changes, migration and deletion, SHALL be asynchronous and resolve only after the sidecar has been written.

#### Scenario: Persisted before resolved
- **WHEN** `toggleResolved` resolves
- **THEN** the sidecar on storage already reflects the new state

#### Scenario: Concurrent mutations of one session
- **WHEN** two mutations of the same mapping are issued back to back
- **THEN** they are applied in order and the last sidecar write contains both changes

### Requirement: Hashing without Node crypto
The core SHALL compute SHA-256 digests without `node:crypto`: asynchronously over file bytes using the platform's Web Crypto when present, and with a bundled pure implementation for short strings and for platforms without Web Crypto. Digests MUST be byte-identical to the previous implementation.

#### Scenario: Source fingerprint matches an existing sidecar
- **WHEN** a sidecar written by version 1.3.0 is loaded and its source is unchanged
- **THEN** the recomputed source SHA-256 equals the recorded value and the session is not stale

#### Scenario: PDF hash precedes extraction
- **WHEN** a PDF is read and mapped
- **THEN** its digest is computed from the full byte array before PDF parsing begins

### Requirement: Random identifiers without Node crypto
Reply identifiers and any other random ids SHALL be generated with `crypto.getRandomValues`.

#### Scenario: Two replies
- **WHEN** two replies are added in the same millisecond
- **THEN** their ids differ and both have the `r-` prefix and 8 hex characters

### Requirement: In-memory storage for tests
The repository SHALL provide an in-memory implementation of the storage port and host services used by core unit tests.

#### Scenario: Store test without a disk
- **WHEN** a store test maps a PDF fixture onto a source held in the in-memory port
- **THEN** it completes without touching the real file system or any host module
