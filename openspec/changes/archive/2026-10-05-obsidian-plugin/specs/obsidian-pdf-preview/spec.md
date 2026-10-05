## Purpose

Specifies how an annotation's region in the PDF is shown from Obsidian, by delegating to the built-in PDF viewer, with a defined fallback when that cannot highlight a rectangle.

## ADDED Requirements

### Requirement: Preview via the built-in PDF viewer
"Preview in PDF" SHALL open the mapping's PDF in Obsidian's built-in viewer at the annotation's page with the annotation's rectangle highlighted, by opening a link of the form `<pdf path>#page=<n>&rect=<x1>,<y1>,<x2>,<y2>`.

#### Scenario: Preview a highlight
- **WHEN** the user previews an annotation on page 12
- **THEN** the PDF opens in a side pane at page 12 with the annotation's region highlighted

#### Scenario: PDF already open
- **WHEN** the same PDF is already open and the user previews another annotation
- **THEN** the existing pane navigates to the new page and region instead of opening another pane

### Requirement: Coordinate conversion
Rectangle coordinates SHALL be converted from the PDF user space stored in the sidecar (points, origin bottom-left) to the coordinate system the built-in viewer's `rect` parameter expects, per page, accounting for the page's origin and rotation.

#### Scenario: Unrotated page
- **WHEN** an annotation rectangle is `[72, 700, 300, 720]` on an unrotated 612x792 page
- **THEN** the link's rectangle equals the converted rectangle defined by the design and not the raw values if they differ

#### Scenario: Rotated page
- **WHEN** the page is rotated 90 degrees
- **THEN** the converted rectangle encloses the same visual region

### Requirement: Verified assumption with fallback
The `&rect=` behaviour (including on mobile) is an assumption verified by the first spike. If the built-in viewer cannot highlight a rectangle reliably on a platform, the plugin SHALL use its own PDF view (pdfjs rendering with an overlay) on that platform, selected by capability, and the spec scenarios above SHALL hold for either path.

#### Scenario: Viewer cannot highlight on this platform
- **WHEN** the capability for built-in rectangle highlight is false
- **THEN** the preview opens the plugin's own PDF view at the page with the rectangle outlined

### Requirement: Preview follows selection
When a preview pane is open, selecting another annotation in the review panel SHALL update the preview to that annotation, without taking focus from the panel.

#### Scenario: Browse list
- **WHEN** the preview is open and the user selects the next row
- **THEN** the preview shows the next annotation's page and region and keyboard focus stays in the list

### Requirement: Missing PDF
If the mapping's PDF cannot be found in the vault, preview SHALL show a notice naming the expected path and offering to re-locate it.

#### Scenario: PDF moved
- **WHEN** the recorded PDF path no longer exists
- **THEN** the user is told the path and can pick a vault PDF, which updates the mapping's PDF reference after confirmation

### Requirement: Annotation without geometry
An annotation with no usable rectangle SHALL open its page without a highlight.

#### Scenario: Zero-area rectangle
- **WHEN** an annotation's rectangle has zero width or height
- **THEN** the link contains only `#page=<n>`
