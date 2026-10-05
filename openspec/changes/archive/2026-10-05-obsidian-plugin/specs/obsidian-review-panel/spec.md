## Purpose

Defines the single right-sidebar "Eddie Review" view that replaces the VS Code Problems panel, tree view and comment threads: a filterable annotation list, the selected annotation's thread, and its actions.

## ADDED Requirements

### Requirement: One sidebar view
The plugin SHALL provide one right-sidebar view titled "Eddie Review" containing a header (current document, round and mapping, with switchers), the annotation list, the selected annotation's thread, and the action buttons. It SHALL be openable from a command and a ribbon icon, and be restored with the workspace layout.

#### Scenario: Open from command
- **WHEN** the user runs "Eddie Doc: Open PDF Review" or "Eddie Doc: Show Review Panel"
- **THEN** the view opens in the right sidebar and shows the active mapping of the current `.adoc`

#### Scenario: Empty state
- **WHEN** the current document has no mapping
- **THEN** the view shows a message and a button that starts mapping an annotated PDF

#### Scenario: Layout restore
- **WHEN** Obsidian restarts with the view open
- **THEN** the view is restored and repopulated from the sidecars

### Requirement: Annotation list
The list SHALL show every annotation of the active mapping in source order, each row with its remark number, kind, page, status (unresolved, resolved, unmatched, needs review, stale) and a one-line excerpt. Selecting a row SHALL reveal it in the source editor.

#### Scenario: Row content
- **WHEN** annotation 7 is a highlight on page 12 matched at confidence 0.62
- **THEN** its row shows `7`, the highlight kind, `p12`, a needs-review status and an excerpt

#### Scenario: Selecting a row
- **WHEN** the user selects a row for a matched annotation
- **THEN** the source editor scrolls to and highlights its line and the thread section shows that annotation

### Requirement: Filters
The list SHALL be filterable by status (unresolved, resolved, unmatched, low-confidence), by page and by annotation kind, filters SHALL combine with AND, and the active filters and counts SHALL be visible. "Low-confidence" SHALL mean matched below the `highConfidence` setting and not confirmed.

#### Scenario: Unmatched filter
- **WHEN** the user selects the unmatched filter
- **THEN** only annotations without a source match are listed and the count reflects them

#### Scenario: Combined filters
- **WHEN** the user selects unresolved and page 12 and kind strikeout
- **THEN** only unresolved strikeouts on page 12 are listed

#### Scenario: Show resolved off
- **WHEN** `showResolved` is false and no explicit resolved filter is chosen
- **THEN** resolved annotations are not listed

### Requirement: Thread view
For the selected annotation the view SHALL show the **Reviewer**'s mark (quoted text, note, author, read-only), the replies in order with author and time, a reply box, and a resolve toggle. Adding, editing and deleting a reply and toggling resolved SHALL persist to the sidecar immediately.

#### Scenario: Reviewer mark is read-only
- **WHEN** the user views the first post of a thread
- **THEN** it has no edit or delete control

#### Scenario: Add a reply
- **WHEN** the user types "Done in ch.2" and submits
- **THEN** the reply appears with the configured author name and the sidecar contains it

#### Scenario: Edit and delete own reply
- **WHEN** the user edits a reply, then deletes another
- **THEN** the edited text keeps its id and original timestamp and the deleted reply is absent from the sidecar

#### Scenario: Resolve
- **WHEN** the user toggles resolve on an unresolved annotation
- **THEN** its row shows resolved and the editor markup updates

### Requirement: Action buttons
The view SHALL provide, for the selected annotation, buttons for: apply edit, confirm match, re-link to cursor, re-map this annotation, reveal in source, and preview in PDF. A button whose action does not apply SHALL be hidden or disabled.

#### Scenario: Confirm match
- **WHEN** the user presses Confirm match on a needs-review annotation
- **THEN** the annotation leaves the needs-review state and is persisted as confirmed

#### Scenario: Re-link to cursor
- **WHEN** the user places the editor cursor on line 40 and presses Re-link
- **THEN** the annotation's manual line becomes 40, it is confirmed, and its stale flag is cleared

#### Scenario: Apply edit not applicable
- **WHEN** the selected annotation is a comment with no suggested replacement
- **THEN** the apply-edit button is disabled

#### Scenario: Re-map this
- **WHEN** the user presses Re-map this on an annotation whose paragraph moved
- **THEN** the matcher is re-run for that annotation only and the list updates

### Requirement: Round and mapping switching
The view header SHALL let the user switch between rounds and mappings of the document, start a new round, add or append a PDF, merge mappings, edit round details and remove a mapping.

#### Scenario: Switch round
- **WHEN** the user chooses round 2 in the header
- **THEN** the list and editor markup show round 2's annotations

#### Scenario: Remove mapping needs confirmation
- **WHEN** the user chooses Remove this mapping
- **THEN** a confirmation is shown and only the sidecar is deleted, never the PDF or the manuscript

### Requirement: Unmatched triage
The view SHALL let the user step through unmatched annotations one at a time and link each to the cursor line, search for a line, skip, or leave it.

#### Scenario: Triage flow
- **WHEN** the user starts triage with three unmatched annotations
- **THEN** each is shown in turn with its quoted text and the PDF location, and chosen links are persisted

### Requirement: Mobile layout
On a narrow viewport the view SHALL present the list and the thread as two stacked states (list, then detail with a back control) and keep all action buttons reachable.

#### Scenario: Phone width
- **WHEN** the view is opened on a phone
- **THEN** selecting a row shows the thread full-width with a back control to the list

### Requirement: Live updates
The view SHALL refresh when the active mapping changes, when the active document changes, and when settings affecting display change, without losing a half-typed reply.

#### Scenario: Re-map while composing
- **WHEN** a save-triggered re-map completes while the user has typed text in the reply box
- **THEN** the list updates and the reply box keeps its text and focus
