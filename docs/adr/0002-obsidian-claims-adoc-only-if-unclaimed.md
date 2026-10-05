# Obsidian: claim `.adoc` only if no other plugin has

Obsidian has no native AsciiDoc support, and only one plugin can register a file extension. Eddie therefore registers `adoc` onto Obsidian's built-in source editor only when no other handler holds it, so it works standalone on desktop and mobile. When another AsciiDoc plugin owns the extension, Eddie leaves it alone and, whenever it needs to show the source, opens it in Obsidian's built-in editor in source mode in its own tab, where its CodeMirror 6 markup works.

Delivered in two stages: stage 1 is the standalone claim; stage 2 is pairing with the plugin that holds the extension. Rendering AsciiDoc is a non-goal — Eddie works on source text and anchors.

## Revision after reading AsciiDoc Live

The first design for stage 2 was to append Eddie's CodeMirror extensions to the other plugin's editor. Reading AsciiDoc Live's source showed that cannot work for the plugin most likely to be installed: it registers `adoc`, `asciidoc` and `asc` under its own view, a `TextFileView` that shows rendered HTML and offers a plain `<textarea>` for source, with no CodeMirror in it. It is also desktop-only. Its README says it refreshes its preview from edits made in Obsidian's built-in editor in another pane, which is the pairing adopted here: Eddie opens its own source tab (`setViewState({ type: "markdown", mode: "source" })`) for a file whose extension it did not claim, and the two plugins sit side by side. An attempt to append extensions to a foreign view that does expose a CodeMirror editor is kept as a best effort. That a Markdown view accepts a file whose extension another plugin registered is the assumption to check on a real install (docs/obsidian-qa.md §2).

## Considered options

- **Always claim `.adoc`.** Rejected: conflicts with users' installed AsciiDoc plugins.
- **Never claim; pair only.** Rejected: Eddie would do nothing without a third-party plugin, and its attach path depends on how well each plugin exposes its editor.
