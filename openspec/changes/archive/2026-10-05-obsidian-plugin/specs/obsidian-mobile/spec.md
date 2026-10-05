## Purpose

Specifies Obsidian mobile support: full feature parity on the same code path, bounded by device capability flags, with progress reporting for long operations and a device spike that gates the work.

## ADDED Requirements

### Requirement: Plugin runs on mobile
The plugin manifest SHALL declare `isDesktopOnly: false`, and the plugin bundle MUST NOT require Node.js, Electron or any desktop-only Obsidian API at load time on mobile.

#### Scenario: Load on a phone
- **WHEN** the plugin is enabled in Obsidian on iOS or Android
- **THEN** it loads without error and its commands, panel and settings tab are available

#### Scenario: Desktop-only feature on mobile
- **WHEN** a feature requires a desktop-only API (native file picker, local Ollama)
- **THEN** its control is hidden or disabled and no desktop API is called

### Requirement: Full parity on one code path
On mobile, extracting annotations, mapping, re-mapping, stamping a reviewed PDF, exporting a report, and extracting annotations as AsciiDoc SHALL run through the same core code as on desktop, with differences expressed only through host capability flags.

#### Scenario: Map on a phone
- **WHEN** the user maps a 300-page annotated PDF stored in the vault on a phone
- **THEN** a sidecar is produced whose items equal those produced on desktop for the same inputs

#### Scenario: Operation unsupported on this device
- **WHEN** a capability flag for an operation is false on the device
- **THEN** the operation's controls are disabled with a message naming the limitation, and no other behaviour changes

### Requirement: Capability flags
The core SHALL expose a `Capabilities` object supplied by the host, including whether absolute paths work, whether PDF extraction and stamping are available, the PDF worker mode (worker, main-thread, none), whether the semantic fallback and a native file picker are available, and an optional maximum PDF size; core and UI SHALL consult it instead of branching on platform.

#### Scenario: Extraction flag false
- **WHEN** the host reports PDF extraction unavailable
- **THEN** mapping commands are disabled with an explanation and existing sidecars remain readable and editable

#### Scenario: Size limit
- **WHEN** a PDF exceeds the host's maximum size
- **THEN** the user is told the size and limit before any work starts

### Requirement: Progress and responsiveness
PDF extraction and stamping SHALL process page by page, report progress (page n of N) to the host, support cancellation, and yield to the UI between pages so the app remains interactive.

#### Scenario: Long extraction
- **WHEN** a 300-page PDF is being read
- **THEN** the UI shows page progress, remains scrollable, and the user can cancel

#### Scenario: Cancel
- **WHEN** the user cancels during extraction
- **THEN** no sidecar is written or modified and the PDF's imported copy, if made, is removed

### Requirement: Memory discipline on mobile
Extraction SHALL release each page's resources after reading it and SHALL NOT hold per-page rendered canvases.

#### Scenario: Large PDF
- **WHEN** a large PDF is processed on a device
- **THEN** only text and annotation data are retained per page and the operation either completes or fails with a clear error, never with a frozen UI

### Requirement: PDF engine strategy
The Obsidian bundle SHALL use the pdfjs browser build with a worker created from an inline or blob source; if worker creation fails on a platform the engine SHALL fall back to main-thread processing with progress yielding, and the resulting worker mode SHALL be reported in the capabilities. The Node-only legacy build MUST NOT be part of the Obsidian bundle, and the existing `Promise.withResolvers` polyfill SHALL be retained.

#### Scenario: Blob worker blocked
- **WHEN** blob worker creation throws on a device
- **THEN** extraction runs in main-thread mode, still page-by-page and cancellable

### Requirement: Spike first
Before any other Obsidian work proceeds, a device spike SHALL run on a real phone with a PDF of about 300 pages and record for each operation (extract, map, re-map, stamp, report, preview with `&rect=`): success, elapsed time, peak behaviour (freeze or crash), worker mode, and any workaround; results SHALL set the capability flags' defaults.

#### Scenario: Spike records failure
- **WHEN** stamping crashes the app on the test phone
- **THEN** the spike report records it and the stamping capability is defaulted off for mobile until fixed

#### Scenario: Spike gates the work
- **WHEN** the spike has not been completed
- **THEN** later Obsidian tasks do not start

### Requirement: Touch-friendly interaction
Every review action SHALL be reachable by touch without hover, with controls of at least 44 px touch height in the panel, and hover details SHALL be reachable by long-press or tap.

#### Scenario: Resolve on a phone
- **WHEN** the user taps an annotation and then the resolve control
- **THEN** the annotation is resolved without any hover interaction

### Requirement: Storage works with mobile sync
All review data SHALL live in visible vault folders so mobile sync can carry it, and the plugin SHALL tolerate a sidecar being replaced on disk by a sync while the vault is open.

#### Scenario: Sidecar updated by sync
- **WHEN** a sidecar file changes on disk after a sync
- **THEN** the plugin reloads that mapping without losing unsaved reply text in the panel
