# Instructions for agents editing an anchored manuscript

Copy the block below into the `CLAUDE.md` (or `AGENTS.md`) of the repo that holds
your `.adoc` files — not this repo. It tells a coding agent how to treat
`// eddie:<id>` anchors while rewriting your prose.

Anchors are the only durable link between an editor's mark and its paragraph. An
agent that strips them has not broken the build or the render — nothing visible
happens at all. The damage shows up on the next re-map, when marks fall back to
matching the editor's old wording against rewritten text and land on whichever
paragraph still shares its vocabulary. So this is worth stating explicitly to
anything that edits the manuscript.

---

## Eddie Doc anchors (`// eddie:<id>`)

Lines like `// eddie:a3f21c94` bind an editor's PDF annotation to the block below
them. They are AsciiDoc comments — Asciidoctor strips them before rendering, so
they never reach a PDF or any delivered file. They are also the only thing
keeping each editorial mark attached to the right paragraph: without them, a
rewrite silently relocates marks to whatever text still resembles the editor's
original wording.

When editing a `.adoc` file in this repo:

- **Rewrite the prose freely.** That is what the anchor is for — the mark stays
  attached however completely the text beneath the marker changes.
- **Never edit, renumber, reformat or reflow a marker line.** Carry it through
  verbatim, on its own line, including when rewriting a whole file. The line is
  matched strictly: lowercase `eddie:`, no space after the colon, a lower-case
  hex id. `// Eddie: a3f21c94` is not a marker — tidying the comment destroys the
  anchor silently.
- **Keep each marker immediately above its block**, and above any attribute list
  or title glued to that block (`[#id]`, `[source,ruby]`, `[NOTE]`, `.Caption`) —
  never between an attribute line and the block it belongs to.
- **Do not insert a new block between a marker and the block it anchors.** A
  marker binds to the first content line beneath it, so an inserted paragraph
  steals the mark.
- **Move markers with their block**, as one unit, when reordering.
- **Splitting a block:** the marker stays with the part the editor's remark is
  actually about.
- **Copying a block: delete the copied markers.** An id must appear once per
  file; a duplicate resolves to whichever occurrence comes first.
- **Delete a marker only when deleting the paragraph it anchors** — then it
  should go, because that mark is genuinely homeless and Eddie Doc will say so.
- **Several markers may stack above one block** — several marks on one paragraph,
  or marks from several review rounds. Keep the whole stack.
- **Never add markers by hand.** Eddie Doc writes them when a PDF is mapped;
  *Eddie Doc: Remove Source Anchors* (or `eddie-doc strip <file.adoc>`) removes
  them.

Review state lives in `.eddie/**/*.review.json`. It is generated — do not
hand-edit it — and it is committed with the manuscript, so a change that moves or
removes anchors belongs in the same commit as the sidecars.
