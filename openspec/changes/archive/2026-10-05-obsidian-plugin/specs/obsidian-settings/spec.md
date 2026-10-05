## Purpose

Defines the Obsidian settings tab, which carries the same keys and semantics as the VS Code `eddieDoc.*` settings with Obsidian-appropriate defaults and a mobile-safe author name.

## ADDED Requirements

### Requirement: Same settings, same semantics
The plugin SHALL provide a settings tab exposing `reviewFolder`, `importPdfs`, `stampOutput`, `reportOutput`, `matchThreshold`, `showResolved`, `autoAnchor`, `inlineMarkers`, `expandThreads`, `highConfidence`, `semanticFallback`, `ollamaUrl`, `embedModel`, `semanticThreshold`, `lexicalFallback`, `authorName` and `lexicalThreshold`, each with the same meaning, type, range and enumerated values as the VS Code setting of the same name, except where this spec states a different default or behaviour.

#### Scenario: Threshold bounds
- **WHEN** the user enters 1.4 for `matchThreshold`
- **THEN** the value is rejected or clamped to the range 0 to 1 and the previous valid value is kept in storage

#### Scenario: Enumerated outputs
- **WHEN** the user opens `stampOutput`
- **THEN** the choices are "reviewFolder" and "besidePdf" with the same meanings as in VS Code

### Requirement: Obsidian defaults
The plugin defaults SHALL equal the VS Code defaults except `reviewFolder`, whose default is `Eddie Reviews`. The defaults are: `importPdfs` true (and forced, see below), `stampOutput` reviewFolder, `reportOutput` reviewFolder, `matchThreshold` 0.5, `showResolved` true, `autoAnchor` true, `inlineMarkers` true, `expandThreads` false, `highConfidence` 0.75, `semanticFallback` false, `ollamaUrl` http://localhost:11434, `embedModel` embeddinggemma, `semanticThreshold` 0.62, `lexicalFallback` true, `authorName` empty, `lexicalThreshold` 0.6.

#### Scenario: Fresh install
- **WHEN** the plugin is installed for the first time
- **THEN** mapping a PDF writes the sidecar under `Eddie Reviews/` in the vault

### Requirement: Visible review folder
The `reviewFolder` default SHALL be a non-dot folder at the vault root. A value beginning with `.` SHALL be accepted only after a warning that Obsidian does not index or sync dot-folders.

#### Scenario: Dot folder chosen
- **WHEN** the user sets `reviewFolder` to `.eddie`
- **THEN** a warning is shown stating that Obsidian does not index or sync it, and the value is saved only if the user confirms

#### Scenario: Absolute path
- **WHEN** the user sets `reviewFolder` to an absolute path
- **THEN** the value is rejected with an explanation that paths must be inside the vault

### Requirement: Imported PDFs are forced on
On Obsidian the `importPdfs` behaviour SHALL always be on: an annotated PDF mapped from outside the review folder is copied into the round's `pdf/` folder. The settings tab SHALL display `importPdfs` as on and not editable, with an explanation.

#### Scenario: PDF in another vault folder
- **WHEN** the user maps `Inbox/ch1-marked.pdf`
- **THEN** a copy is placed at `Eddie Reviews/.../rev-1/pdf/<mapping>.pdf` and the sidecar points at the copy

### Requirement: Author name without git
`authorName` SHALL be used on replies. When it is empty the plugin SHALL prompt once for a name, store it in the setting, and use it thereafter; it MUST NOT depend on `git config`.

#### Scenario: First reply
- **WHEN** the user submits their first reply and `authorName` is empty
- **THEN** a prompt asks for a name, the answer is saved to the setting, and the reply uses it

#### Scenario: Prompt cancelled
- **WHEN** the user cancels the prompt
- **THEN** the reply is not saved and nothing is changed

### Requirement: Semantic fallback settings are desktop-only
The settings `semanticFallback`, `ollamaUrl`, `embedModel` and `semanticThreshold` SHALL be hidden on mobile and ignored there. On desktop the fallback SHALL reach Ollama through Obsidian's request API.

#### Scenario: Mobile
- **WHEN** the settings tab is opened on mobile
- **THEN** no semantic-fallback control is shown and mapping never contacts a local server

#### Scenario: Ollama unreachable
- **WHEN** `semanticFallback` is true on desktop and the server cannot be reached
- **THEN** one warning naming the URL and model is shown per session and mapping continues with the remaining tiers

### Requirement: Settings apply live
Changing a setting SHALL take effect without restarting Obsidian: review-folder changes re-discover sidecars, display settings refresh the panel and editor markup.

#### Scenario: Change review folder
- **WHEN** the user changes `reviewFolder` to `Reviews`
- **THEN** sidecars under `Reviews/` are discovered and already-loaded mappings keep their own paths

#### Scenario: Toggle inline markers
- **WHEN** the user turns `inlineMarkers` off
- **THEN** end-of-line markers disappear from open editors immediately

### Requirement: Settings persistence and migration safety
Settings SHALL be stored in the plugin's data file; unknown or invalid stored values SHALL fall back to defaults without preventing load.

#### Scenario: Corrupt data file
- **WHEN** the stored settings contain a string for `matchThreshold`
- **THEN** the plugin loads with the default 0.5 for that key and the other valid keys are kept
