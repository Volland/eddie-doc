## Purpose

Defines how the Obsidian plugin makes `.adoc` and `.asciidoc` files editable as source and reviewable, without displacing any AsciiDoc plugin the user already runs (ADR 0002).

## ADDED Requirements

### Requirement: Claim AsciiDoc extensions only when unclaimed
On load the plugin SHALL register the extensions `adoc` and `asciidoc` onto Obsidian's built-in markdown view in source mode if and only if no other view type is already registered for that extension. An extension held by another handler SHALL be left untouched.

#### Scenario: Nobody holds the extension
- **WHEN** the plugin loads and no handler is registered for `adoc`
- **THEN** `adoc` is registered, and opening `chapter.adoc` shows an editable source editor

#### Scenario: Another plugin holds the extension
- **WHEN** the plugin loads and AsciiDoc Live already handles `adoc`
- **THEN** the plugin does not register `adoc`, shows a one-time notice naming the situation, and writes a log line

#### Scenario: Detection API unavailable
- **WHEN** Obsidian does not expose the view registry in the way the plugin expects
- **THEN** the plugin treats the extension as claimed, does not register, and logs that it could not verify

### Requirement: Source mode without markdown rendering
A file opened through the plugin's claim SHALL be shown as plain source text. Markdown Live Preview rendering MUST NOT be applied to AsciiDoc content, and the file MUST NOT be switched to reading view.

#### Scenario: Heading syntax
- **WHEN** an `.adoc` file containing `== Section` is opened through the claim
- **THEN** the text is displayed literally, not rendered as a markdown heading

#### Scenario: Reading view requested
- **WHEN** the user toggles reading view on a claimed file
- **THEN** the plugin keeps the file in source mode

### Requirement: Claim is reversible
Unloading or disabling the plugin SHALL release the extensions it registered.

#### Scenario: Plugin disabled
- **WHEN** the user disables the plugin
- **THEN** `adoc` no longer opens in the plugin's source mode and no Eddie decoration remains

### Requirement: Attach to editors owned by another plugin
When `adoc` or `asciidoc` is handled by another plugin, the plugin SHALL show its editor markup (highlights, gutter markers, hover) by opening the file in Obsidian's built-in editor in source mode in its own tab, beside the other plugin's view; and SHALL additionally attach to any such foreign view that exposes a CodeMirror 6 editor. *(As built: the side-by-side tab is the primary mechanism, because AsciiDoc Live's view has no CodeMirror editor; see ADR 0002.)*

#### Scenario: AsciiDoc Live owns the extension
- **WHEN** a review is loaded for `chapter.adoc`, AsciiDoc Live handles `adoc`, and the user selects an annotation
- **THEN** `chapter.adoc` opens in a new tab in Obsidian's built-in editor in source mode with the annotated lines highlighted, and the AsciiDoc Live tab is left as it was

#### Scenario: Obsidian does not give a Markdown view for the file
- **WHEN** the resulting view is not a Markdown view
- **THEN** Eddie Doc shows a notice that the file opened in a view it cannot mark up, and the review panel and commands keep working

### Requirement: Rendering AsciiDoc is not provided
The plugin MUST NOT render AsciiDoc to HTML or register an AsciiDoc preview.

#### Scenario: Preview requested
- **WHEN** the user looks for an AsciiDoc preview from Eddie Doc
- **THEN** none exists and the documentation states this is out of scope

### Requirement: Other AsciiDoc extensions are recognised for review
Files with extension `adoc`, `asciidoc`, `asc` or `ad` SHALL be accepted as review sources whichever handler opens them.

#### Scenario: `.asc` source
- **WHEN** the user runs Open PDF Review on `notes.asc`
- **THEN** the review proceeds even though the plugin did not register `asc`

### Requirement: Renamed or moved sources keep their reviews
When a source file with mappings is renamed or moved inside the vault, its mappings SHALL follow it: sessions are re-keyed and each affected sidecar is rewritten so its recorded source path points at the new location.

#### Scenario: Rename a manuscript
- **WHEN** the user renames `manuscript/ch1.adoc` to `manuscript/chapter-1.adoc`
- **THEN** the mapping is still shown for the renamed file and its sidecar's `source.path` resolves to the new path

#### Scenario: Rename a sidecar's PDF
- **WHEN** a PDF referenced by a sidecar is renamed in the vault
- **THEN** the sidecar's `pdf.path` is updated to the new path
