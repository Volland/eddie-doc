# Eddie Doc v0.1.0

First release. Map an editor's PDF annotations back onto your AsciiDoc source — highlights, strikethroughs, comments, and inserted text become navigable, resolvable review items in the editor.

## Highlights

- **Open PDF Review** from the AsciiDoc editor title bar, the command palette, or by right-clicking an `.adoc`/`.pdf` in the Explorer.
- Fuzzy-matches annotated PDF text back to source lines, with a configurable match threshold.
- Tree view of annotations with resolve/re-link actions, source decorations, and next/previous navigation.

## Fixes

- **"Open PDF Review" no longer crashes on the VS Code extension host.** pdfjs 4.x calls `Promise.withResolvers` (Node 22+ only), which is absent on the extension host's Node (18–20). Added a polyfill loaded before pdfjs so PDF extraction works everywhere.
- Right-click context menus for both `.adoc` and `.pdf` files; the command now auto-pairs source and PDF.

## Install

Download `eddie-doc-0.1.0.vsix` below, then:

```
code --install-extension eddie-doc-0.1.0.vsix
```

Or in VS Code: Extensions view → **⋯** → **Install from VSIX…**
