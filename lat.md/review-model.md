# Review model

The durable artifact Eddie Doc produces is the review sidecar, one file per mapping, shared by every Host.

## Review sidecar

A sidecar is `<mapping>.review.json`: the annotations recovered from one annotated PDF, where each landed, and the author's resolution state.

It uses relative paths and content fingerprints so it is portable and can be committed. The normative spec is `docs/FORMAT.md` and the schema is `schema/review-v3.schema.json`. [[src/core/model/format.ts#serialize]] and [[src/core/model/format.ts#parse]] are the only code that reads or writes the on-disk shape.

### Interop between Hosts

The VS Code extension, the Obsidian plugin and the CLI read and write the same format, so a vault or repository opened in two Hosts stays consistent.

Only the default location differs: `.eddie` for VS Code and the CLI, a visible `Eddie Reviews` folder for Obsidian. Paths inside a sidecar are relative to the sidecar, so moving the review folder does not break them.

## Rounds and mappings

A manuscript is reviewed over several rounds, and a round can return as several annotated PDFs; each PDF is one mapping.

[[src/core/model/store.ts#ReviewStore]] owns the loaded mappings, grouped by document and round, with exactly one active mapping per document. A new round inherits state from the previous one. A second editor's PDF joins the round in progress as a separate mapping, or is appended to an existing mapping so it stays one numbered list.

### Numbering

Each remark gets a stable number and the reviewer's initials, assigned in reading order and kept when the sidecar is rewritten.

[[src/core/model/numbering.ts#assignNumbers]] numbers whatever is unnumbered and never renumbers what already has a number, so replies that quote "#7" stay correct.

### Combining mappings

Several mappings of one document can be merged into one list, or PDFs appended to a mapping, without losing numbers, replies or resolutions.

[[src/core/model/combine.ts#mergeInto]] folds mappings together and reports repeated marks; [[src/core/model/combine.ts#appendItems]] adds another PDF's marks and skips ones the mapping already holds.

## Layout

Where a sidecar, a copied PDF and a report go is computed from the manuscript path and the review folder setting.

[[src/core/model/layout.ts#documentFolder]] mirrors the manuscript tree under the review root, so two `chapter-01.adoc` files in different folders cannot collide. Rounds are `rev-N` folders; copied PDFs live in each round's `pdf/` folder. With an empty review folder the historical `<file>.review.json` beside the manuscript is used.
