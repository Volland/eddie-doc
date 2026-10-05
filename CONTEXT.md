# Eddie Doc

Maps the annotations an editor left on a PDF back onto the AsciiDoc source the PDF was built from, and tracks the author's resolution of each one across review rounds.

## Language

**Host**:
An application Eddie Doc runs inside or alongside: VS Code, Obsidian (desktop and mobile), or the command line. A host supplies the editor surface, file access and settings; it does not own review logic.
_Avoid_: Platform, client, editor (an editor is also a person — see Reviewer)

**Workspace**:
The folder tree a **Host** treats as the project root: a VS Code workspace folder or an Obsidian vault. Every file Eddie Doc touches is identified by its path relative to it.
_Avoid_: Project, vault (Obsidian-only), root

**Mapping**:
One annotated PDF recovered onto one AsciiDoc source, stored as one **Review sidecar**.
_Avoid_: Import, session

**Round**:
One revision of the manuscript under review; holds one or more **Mappings**, one per annotated PDF returned for that revision.
_Avoid_: Pass, version

**Review sidecar**:
The `<mapping>.review.json` file recording every annotation of one **Mapping**, where each landed in the source, and its resolution state. Readable by tools other than any **Host**.
_Avoid_: Review file, state file

**Annotation**:
One mark a **Reviewer** left on the PDF — a highlight, strikeout, underline, comment or insert — once recovered, with where it landed in the source and whether the author has resolved it.
_Avoid_: Comment (a comment is one kind of annotation), item, remark (the number a mapping gives an annotation is its _remark number_)

**Anchor**:
A `// eddie:<id>` comment written above a paragraph that binds an **Annotation** to that paragraph rather than to a line number, so it survives rewrites.
_Avoid_: Marker (the code's word), bookmark

**Review panel**:
The Obsidian **Host**'s single side panel holding the annotation list, the selected annotation's thread and every action on it; it stands in for VS Code's tree view, Problems panel, comment threads and code actions.
_Avoid_: Sidebar, tree

**Reviewer**:
The person who annotated the PDF (copy editor, proofreader).
_Avoid_: Editor, annotator
