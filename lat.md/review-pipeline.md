# Review pipeline

How an editor's annotated PDF becomes review items placed in the AsciiDoc source, and how they are kept in place as the text changes.

## Extraction

pdfjs reads each page's annotations and positioned text; running headers, footers and bare page numbers are stripped before the text is used.

[[src/core/pdf/extract.ts#extractAnnotations]] returns one raw annotation per mark, with its kind, page, rectangle, quoted text and the editor's note. [[src/core/pdf/extract.ts#readPages]] returns the page text layer, which stamping reuses in the opposite direction so both tokenize identical input. pdfjs detaches the buffer it is given, so a copy is passed and the caller's bytes are hashed first.

## Mapping

Each annotation is linked to a source line by word-level fuzzy matching, then rescued by fallbacks for what it could not place.

[[src/core/matching/mapper.ts#mapAnnotations]] scores annotations against an index of the source; a score at or above the match threshold links them. Unplaced marks go to the character-trigram fallback ([[src/core/matching/lexical.ts]]) and, when enabled on a Host that can reach it, the embedding fallback ([[src/core/matching/semantic.ts]]) which asks a local Ollama server. A mark scoring below the high-confidence threshold is Needs review rather than Open.

### Carrying state forward

Annotation ids change every time a PDF is exported, so review state is carried into a new round by a content fingerprint.

Resolved flags, notes and replies from the previous round's mapping reattach to the same remark in the new one. The previous mapping is the same editor's work when the origins agree, else that round's newest.

## Anchors

Anchoring writes a `// eddie:<id>` comment above each located paragraph and records how to find it again, so a mark follows its paragraph through rewrites.

Markers are AsciiDoc comments, so they never render. [[src/core/source/markers.ts#injectMarkers]] adds them and [[src/core/source/markers.ts#resolveAnchor]] finds an annotation again by marker, then block id, then fingerprint, then text. Import is the one moment the source still resembles what the editor read, which is why anchoring happens at map time.

## Live position tracking

Between saves, edits shift every annotation's line so reveal and decorations keep pointing at the right text.

[[src/core/matching/posTrack.ts#shiftLine]] applies a batch of `ContentChange`s, which must arrive in descending document order. The save-time re-map then reconciles positions against content.

## Edits from annotations

An annotation can suggest a source edit, planned as plain offsets so any Host applies it as one undoable change.

[[src/core/edits/plan.ts#planDeleteStruck]], [[src/core/edits/plan.ts#planReplaceMarked]], [[src/core/edits/plan.ts#planInsertAtMark]], [[src/core/edits/plan.ts#planDeleteLines]] and [[src/core/edits/plan.ts#planInsertNote]] build a single edit; [[src/core/edits/plan.ts#planAllConfident]] builds every safe one for the bulk action and `overlaps` rejects a colliding set. The bulk deletion takes the exact range, with no single-edit space cleanup, so neighbours cannot claim the same space.

## Classification

Every annotation sits in exactly one of four groups, decided in one place so every Host's list agrees.

[[src/core/view/annotationView.ts#bucketOf]]: resolved wins; otherwise no source place means Unmatched; otherwise a link below the high-confidence threshold, or one gone stale, means Needs review; the rest are Open. A hand-placed link is trusted.

## Output

A review leaves the tool as a Markdown report, a stamped PDF, or AsciiDoc extracted from the PDF.

[[src/core/model/report.ts#renderReport]] writes the report. [[src/core/pdf/stamp.ts]] writes the review onto a freshly rendered PDF as `<name>.reviewed.pdf`, never modifying the clean render. [[src/core/pdf/toAdoc.ts#annotationsToAdoc]] turns a PDF's annotations into an `.adoc`.
