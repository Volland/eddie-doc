## Purpose

Defines the Obsidian command set that carries every `Eddie Doc: ...` VS Code command, and how each VS Code UI surface maps onto an Obsidian surface.

## ADDED Requirements

### Requirement: Every VS Code command has an Obsidian counterpart
Each of the 29 VS Code commands titled `Eddie Doc: ...` SHALL be available in Obsidian as a registered command, a panel button, an editor-menu item, or a combination, as listed in the table below. Obsidian prefixes command names with the plugin name, so a command's name SHALL NOT repeat "Eddie Doc:".

| VS Code command | Obsidian command id | Name | Surfaces | Mobile | Desktop-only |
| --- | --- | --- | --- | :-: | :-: |
| `eddieDoc.openReview` | `open-review` | Open PDF review | palette, ribbon, file menu on `.adoc`/`.pdf` | yes | no |
| `eddieDoc.refresh` | `remap` | Re-map annotations | palette, panel header | yes | no |
| `eddieDoc.switchReview` | `switch-review` | Switch review | palette, panel header, status bar (desktop) | yes | no |
| `eddieDoc.switchMapping` | `switch-mapping` | Switch round / mapping | palette, panel header | yes | no |
| `eddieDoc.activateMapping` | `activate-mapping` | Show this round | panel only | yes | no |
| `eddieDoc.newRevision` | `new-round` | Start new review round | palette, panel menu | yes | no |
| `eddieDoc.addMapping` | `add-mapping` | Add annotated PDF to current round | palette, panel menu | yes | no |
| `eddieDoc.appendPdf` | `append-pdf` | Add PDFs to this mapping | palette, panel menu | yes | no |
| `eddieDoc.mergeMappings` | `merge-mappings` | Merge mappings into this one | palette, panel menu | yes | no |
| `eddieDoc.editMappingInfo` | `edit-round-details` | Edit round details | palette, panel menu | yes | no |
| `eddieDoc.deleteMapping` | `remove-mapping` | Remove this mapping | panel only | yes | no |
| `eddieDoc.migrateReviews` | `migrate-reviews` | Move reviews into review folder | palette | yes | no |
| `eddieDoc.openReviewFolder` | `open-review-folder` | Open review folder | palette, panel menu (reveals in file explorer) | yes | no |
| `eddieDoc.extractAnnotations` | `extract-annotations` | Extract annotations as AsciiDoc | palette, file menu on `.pdf` | yes | no |
| `eddieDoc.nextAnnotation` | `next-annotation` | Next annotation | palette, hotkey-bindable | yes | no |
| `eddieDoc.prevAnnotation` | `previous-annotation` | Previous annotation | palette, hotkey-bindable | yes | no |
| `eddieDoc.toggleResolved` | `toggle-resolved` | Toggle resolved | palette, panel, editor menu | yes | no |
| `eddieDoc.revealAnnotation` | `reveal-annotation` | Reveal in source | panel, palette | yes | no |
| `eddieDoc.relink` | `relink-to-cursor` | Re-link to current cursor line | palette, panel, editor menu | yes | no |
| `eddieDoc.relinkPick` | `reselect-source-line` | Reselect source line | panel only | yes | no |
| `eddieDoc.remapItem` | `remap-annotation` | Re-map this annotation | panel, editor menu | yes | no |
| `eddieDoc.confirmMatch` | `confirm-match` | Confirm match | palette, panel, editor menu | yes | no |
| `eddieDoc.applyAllEdits` | `apply-confident-edits` | Apply all confident edits | palette, panel header | yes | no |
| `eddieDoc.triageUnmatched` | `triage-unmatched` | Triage unmatched annotations | palette, panel | yes | no |
| `eddieDoc.previewAnnotation` | `preview-in-pdf` | Preview in PDF | palette, panel, editor menu | yes | no |
| `eddieDoc.exportReport` | `export-report` | Export review report | palette, panel header | yes | no |
| `eddieDoc.stampPdf` | `stamp-pdf` | Stamp reviewed PDF | palette, panel header | yes (capability-gated) | no |
| `eddieDoc.anchorSource` | `anchor-source` | Anchor annotations in source | palette, panel menu | yes | no |
| `eddieDoc.stripAnchors` | `strip-anchors` | Remove source anchors | palette | yes | no |

The plugin SHALL additionally register `show-panel` ("Show review panel"), `import-pdf-from-disk` ("Import PDF from outside the vault", desktop-only), and `set-author-name` ("Set author name"). The five VS Code reply commands (`addReply`, `editReply`, `saveReply`, `cancelReply`, `deleteReply`) have no palette counterpart and are panel controls.

#### Scenario: Command palette lists commands
- **WHEN** the user opens the Obsidian command palette and types "Eddie Doc"
- **THEN** every command in the table whose Surfaces include "palette" is listed with the plugin prefix, and panel-only commands are not

#### Scenario: Panel-only command
- **WHEN** the user is in the review panel on a mapping row
- **THEN** "Show this round" and "Remove this mapping" are offered there but are absent from the palette

### Requirement: Commands that need context are conditional
Commands that act on the current document, annotation or mapping SHALL be offered only when that context exists, and SHALL otherwise be unavailable rather than failing.

#### Scenario: No review loaded
- **WHEN** the active file has no mapping
- **THEN** "Next annotation" and "Toggle resolved" are not offered while "Open PDF review" is

### Requirement: Surface mapping from VS Code to Obsidian
The plugin SHALL map VS Code UI surfaces to Obsidian surfaces as follows: Comments API threads to the review panel thread section; Diagnostics (Problems panel) to the panel list; Code actions to panel buttons, palette commands and editor-menu items on annotated lines; the annotation tree view to the panel list; the PDF preview webview to Obsidian's built-in PDF viewer; file pickers to a fuzzy-suggest modal over the vault's PDFs plus, on desktop only, a native file picker whose chosen PDF is copied into the vault; the status bar item to an Obsidian status-bar item on desktop and to the panel header on mobile; input boxes and quick picks to Obsidian modals.

#### Scenario: Choosing a PDF in the vault
- **WHEN** a command needs an annotated PDF
- **THEN** a fuzzy-suggest modal lists vault PDFs, most recently modified first, and choosing one proceeds with that file

#### Scenario: Choosing a PDF outside the vault on desktop
- **WHEN** the user picks "Import PDF from outside the vault" and selects `~/Downloads/ch1-marked.pdf`
- **THEN** the PDF is copied into the round's `pdf/` folder in the review folder and mapping proceeds from the copy

#### Scenario: Outside-vault import on mobile
- **WHEN** the user is on mobile
- **THEN** the outside-vault command is not offered and the vault picker is the only chooser

### Requirement: Status bar item and panel header
On desktop, a status-bar item SHALL show the active source and PDF pairing and open the review switcher when clicked; on mobile the same information SHALL appear in the panel header.

#### Scenario: Desktop status bar
- **WHEN** a mapped `.adoc` is active on desktop
- **THEN** the status bar shows its source and PDF names and clicking it opens the review switcher

### Requirement: Apply edits with confirmation
Commands that rewrite the manuscript (apply edit, apply all confident edits, anchor source, remove source anchors) SHALL show the proposed change and require confirmation, and each SHALL be applied as one editor transaction so a single undo reverts it.

#### Scenario: Apply all confident edits
- **WHEN** the user runs "Apply all confident edits" with five high-confidence strikeouts
- **THEN** a summary is shown, and after confirmation all five are applied in one undoable transaction

#### Scenario: Declined
- **WHEN** the user cancels the confirmation
- **THEN** the manuscript is unchanged

### Requirement: Context-menu entry points
The file-explorer menu SHALL offer "Open PDF review" on `.adoc`, `.asciidoc` and `.pdf` files and "Extract annotations as AsciiDoc" on `.pdf` files.

#### Scenario: Right-click a PDF
- **WHEN** the user opens the file menu of `ch1-marked.pdf`
- **THEN** both entries are offered
