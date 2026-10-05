## Purpose

Specifies how annotations are shown inside an Obsidian source editor (line highlights, gutter markers, hover, optional end-of-line markers) and how live edits keep their positions correct.

## ADDED Requirements

### Requirement: Line highlights
For each annotation with a source location in the document's displayed mapping, the editor SHALL highlight the span of lines it covers, using one style for open and one for resolved annotations, and no highlight for unmatched annotations.

#### Scenario: Open annotation
- **WHEN** an unresolved annotation is matched to lines 10 to 12
- **THEN** lines 10 to 12 carry the open-annotation highlight

#### Scenario: Resolved annotation hidden
- **WHEN** `showResolved` is false and an annotation is resolved
- **THEN** its lines carry no highlight

#### Scenario: Unmatched annotation
- **WHEN** an annotation has no match and no manual line
- **THEN** no line is highlighted for it

### Requirement: Gutter markers
The editor SHALL show a gutter marker on the first line of each annotated span, carrying the remark number, and clicking it SHALL select that annotation in the review panel.

#### Scenario: Click gutter marker
- **WHEN** the user taps the marker on line 10
- **THEN** the review panel selects the annotation anchored there

#### Scenario: Several annotations on one line
- **WHEN** three annotations start on the same line
- **THEN** one marker shows the count and tapping it lets the user choose among them

### Requirement: Hover details
Hovering (desktop) or long-pressing (mobile) an annotated line SHALL show the annotation numbers, kinds, notes and status for that line.

#### Scenario: Hover
- **WHEN** the pointer rests on an annotated line
- **THEN** a tooltip lists each annotation's number, kind, note and resolved state

### Requirement: Inline end-of-line markers
When `inlineMarkers` is true the editor SHALL show a marker with the annotation kind at the end of each annotated line as editor decoration only, never written into the file.

#### Scenario: Marker is not saved
- **WHEN** `inlineMarkers` is true and the document is saved
- **THEN** the saved file contains no marker text added by the plugin

#### Scenario: Markers off
- **WHEN** `inlineMarkers` is false
- **THEN** line highlights, gutter markers and hover remain and no end-of-line marker is shown

### Requirement: Live position tracking
Edits to the document SHALL move annotation line positions in memory as the user types, using the same line-shift rules as the other hosts, and a save SHALL schedule a debounced re-map of every round of the document that skips work when the source content is unchanged.

#### Scenario: Insert lines above
- **WHEN** the user inserts two lines above an annotated paragraph
- **THEN** its highlight and gutter marker move down two lines immediately

#### Scenario: Autosave burst
- **WHEN** the user types continuously so the file is saved every few seconds
- **THEN** re-map runs only after typing pauses and does not rewrite a sidecar whose source hash is unchanged

#### Scenario: Multi-cursor replace
- **WHEN** one transaction replaces several ranges
- **THEN** every range is reported to position tracking as a content change in document order

### Requirement: Markup follows the displayed mapping
Editor markup SHALL always show the mapping the review panel has active for that document and update when it changes.

#### Scenario: Switch round
- **WHEN** the user switches from round 1 to round 2
- **THEN** the highlights change to round 2's annotations without reopening the file

### Requirement: Editor menu and commands on annotated lines
The editor context menu SHALL offer Eddie actions (confirm match, resolve, preview in PDF, re-link here, re-map) on an annotated line.

#### Scenario: Right-click annotated line
- **WHEN** the user opens the editor menu on an annotated line
- **THEN** Eddie actions for the annotation on that line are listed

#### Scenario: Right-click plain line
- **WHEN** the user opens the editor menu on a line with no annotation
- **THEN** only "Re-link an annotation here" (if one is selected) is offered

### Requirement: Rebuild only on change
Decorations SHALL be rebuilt only when the displayed annotations, settings or document changed, and a rebuild MUST NOT move the editor cursor or scroll position.

#### Scenario: Unrelated refresh
- **WHEN** a change event fires for a different document
- **THEN** this editor's decorations are not rebuilt
