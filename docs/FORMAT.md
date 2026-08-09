# Eddie Doc Review Format

**Version 3** · media type (proposed) `application/vnd.eddie-doc.review+json` ·
schema: [`schema/review-v3.schema.json`](../schema/review-v3.schema.json) ·
canonical URL: <https://volland.github.io/eddie-doc/schema/review-v3.schema.json>

The **review sidecar** is the durable artifact Eddie Doc produces: a
`<mapping>.review.json` recording every editor annotation recovered from one
annotated PDF, where each maps into the AsciiDoc source, and your review state.
It is designed to be **committed to version control**, **diffed**, and **read by
tools other than the VS Code extension** (a CLI, CI gate, or a different editor).

This document is the normative spec. The JSON Schema is authoritative for
structure; where prose and schema disagree, the schema wins.

## The unit: one file per mapping

A manuscript is edited over several **revisions** (rounds), and a round can come
back as more than one annotated PDF — different copy editors, different sites.
Each PDF mapped onto a source is one **mapping**, and one mapping is one file:

```text
.eddie/manuscript/chapter-01/
  rev-1/
    acme-copyedit.review.json       ← round 1, Acme's marks
  rev-2/
    acme-copyedit.review.json       ← round 2, same editor
    beta-proofread.review.json      ← round 2, a second reviewer
```

Nothing outside the files themselves records this structure: every sidecar names
its own `revision` and `mapping`, so a consumer reconstructs the whole review
history by reading the files it finds — in any layout, including all of them in
one directory. Where Eddie Doc puts them is a setting, not part of the format.

## Design goals

1. **Portable** — no absolute paths. A sidecar checked into a repo works on any
   machine and any clone.
2. **Verifiable** — content fingerprints let a consumer detect that the source
   or PDF changed since mapping ran, without re-running the matcher.
3. **Layered** — each item separates what came *from the PDF* (immutable), what
   the *matcher computed* (a recomputable cache), and what the *user owns*
   (review state). Only the last is hand-edited; the first two are regenerated.
4. **Self-describing** — a file states which round and whose marks it holds, and
   what kind of PDF produced it, so a pile of sidecars needs no index to be
   understood.
5. **Evolvable** — a top-level integer `version` and a `$schema` URL, so
   consumers can branch on format and validate.

## Top-level shape

```jsonc
{
  "$schema": "https://volland.github.io/eddie-doc/schema/review-v3.schema.json",
  "version": 3,
  "producer": { "name": "eddie-doc", "version": "1.1.0" },
  "createdAt": "2026-07-03T07:15:17.937Z",
  "updatedAt": "2026-07-12T09:02:00.000Z",
  "revision": { "id": "rev-2", "ordinal": 2, "label": "Copyedit", "receivedAt": "2026-07-02" },
  "mapping":  { "id": "acme-copyedit", "kind": "annotations",
                "origin": "Acme Editorial", "reviewType": "copyedit" },
  "source": { "path": "../../../manuscript/chapter-01.adoc", "sha256": "…", "bytes": 4213 },
  "pdf":    { "path": "pdf/acme-copyedit.pdf", "sha256": "…",
              "annotationCount": 5, "role": "annotated" },
  "artifacts": [ { "kind": "report", "path": "acme-copyedit.review.md" } ],
  "items":  [ /* … */ ]
}
```

| Field | Req | Meaning |
| --- | :-: | --- |
| `$schema` | – | Format identifier; also the canonical schema URL. |
| `version` | ✓ | On-disk format version. `3` for this spec. |
| `producer` | – | Tool that wrote the file (`name`, optional `version`). |
| `createdAt` / `updatedAt` | ✓ | ISO-8601 timestamps. |
| `revision` | ✓ | The editing round this mapping belongs to. |
| `mapping` | ✓ | What this mapping is and where its marks came from. |
| `source` | ✓ | The `.adoc` input — see [File references](#file-references). |
| `pdf` | ✓ | The PDF input, plus `annotationCount` and `role`. |
| `artifacts` | – | Files produced from this mapping (reports, stamped PDFs). |
| `items` | ✓ | The review items — see [Items](#items). |

### `revision` — the editing round

```jsonc
{ "id": "rev-2", "ordinal": 2, "label": "Copyedit", "receivedAt": "2026-07-02",
  "note": "second pass, structure only" }
```

| Field | Req | Meaning |
| --- | :-: | --- |
| `id` | ✓ | `rev-<ordinal>`. Unique per document; also the folder name. |
| `ordinal` | ✓ | **1-based** round number, as authors count them. |
| `label` | – | Human name for the round. |
| `receivedAt` | – | ISO-8601 date (or date-time) the round came back. |
| `note` | – | Free-form note about the round. |

Every mapping of the same round carries the **same** revision block. Two files
that disagree about a round are a producer bug; a consumer should prefer the one
with the later `updatedAt`.

### `mapping` — whose marks these are

```jsonc
{ "id": "acme-copyedit", "kind": "annotations", "label": "Acme copyedit",
  "origin": "Acme Editorial", "reviewer": "R. Hale", "reviewType": "copyedit" }
```

| Field | Req | Meaning |
| --- | :-: | --- |
| `id` | ✓ | Identity within the round; also the file-name stem. |
| `kind` | ✓ | How the mapping was produced — see below. |
| `label` | – | Human name. Falls back to `origin`, then `id`. |
| `origin` | – | Where the marks came from: publisher, agency, site. |
| `reviewer` | – | The person who made them, when known apart from `origin`. |
| `reviewType` | – | `copyedit`, `proofread`, `developmental`, `technical`, `legal`, `other`. |
| `createdAt` | – | When the mapping was first made. |

**`kind`** says what kind of mapping file this is:

| Kind | Meaning |
| --- | --- |
| `annotations` | PDF annotations extracted and matched onto the source. What Eddie Doc writes today. |
| `manual` | Links made by hand, with no annotation source. |
| `other` | Anything else a producer defines. |

### File references

Both `source` and `pdf` are **file references**:

```jsonc
{ "path": "../../../manuscript/chapter-01.adoc", "sha256": "e3b0c4…", "bytes": 4213 }
```

- **`path`** — relative to the **sidecar's own directory**, always with POSIX
  (`/`) separators, even on Windows. Consumers resolve it against the directory
  the sidecar lives in. Since a sidecar no longer has to sit beside its
  manuscript, `source.path` is **load-bearing**: it is how a consumer finds the
  document a sidecar describes.
- **`sha256`** — hex SHA-256 of the file's bytes at the time mapping last ran.
  Optional (a session migrated from v1 has none until it re-maps). When present,
  a consumer can compare it against the current file to decide whether the
  matches are stale.
- **`bytes`** — size at map time.

**`pdf`** carries three more fields:

| Field | Req | Meaning |
| --- | :-: | --- |
| `annotationCount` | – | Annotations extracted — a cheap staleness signal. |
| `role` | – | What kind of PDF this is. Absent means `annotated`. |
| `imported` | – | True when the PDF was copied in beside the sidecar. |
| `importedFrom` | – | Where an imported PDF came from, relative to the sidecar. |

**`role`** matters because a round involves several PDFs of the same chapter and
they are not interchangeable:

| Role | Meaning |
| --- | --- |
| `annotated` | Came back from an editor with marks on it. The only kind with marks to map. |
| `proof` | A proofing copy; marks optional. |
| `clean` | A fresh render carrying no review markup — what gets stamped. |
| `stamped` | An Eddie Doc output carrying marks and replies. |
| `other` | Anything else. |

### `artifacts` — what this mapping produced

```jsonc
[ { "kind": "report", "path": "acme-copyedit.review.md",
    "createdAt": "2026-07-12T09:10:00.000Z" } ]
```

`kind` is one of `report`, `stampedPdf`, `importedPdf`, `extractedAdoc`,
`other`; `path` is relative to the sidecar. The list is a record, not a
dependency: deleting an artifact does not invalidate the mapping.

## Items

Each item is a PDF annotation, its match into source, and its review state,
kept in three separate blocks so they can evolve and diff independently.

```jsonc
{
  "id": "p2-highlight-48-719",
  "annotation": {
    "kind": "highlight",
    "author": "Editor",
    "comment": "Strong framing — keep this.",
    "anchoredText": "…relationships at the center of the model.",
    "markedText": "relationships at the center of the model",
    "geometry": {
      "page": 2,
      "unit": "pt",
      "origin": "bottom-left",
      "rect": [48.24, 718.58, 547.04, 748.64]
    }
  },
  "match": {
    "startLine": 6,
    "endLine": 7,
    "score": 0.887,
    "method": "fuzzy",
    "sourceExcerpt": "are connected by well-defined relationships. …"
  },
  "state": { "resolved": false }
}
```

### `id`

A stable identifier that survives re-import so review state can be reattached.
Eddie Doc currently derives it from page + rounded geometry
(`p<page>-<kind>-<x>-<y>`). Producers **should** prefer the PDF's own annotation
id (`NM`) when available, since geometry-derived ids change if the PDF is
re-exported at a different position.

### `annotation` — from the PDF (immutable)

| Field | Req | Meaning |
| --- | :-: | --- |
| `kind` | ✓ | One of `highlight`, `strikeout`, `underline`, `comment`, `insert`, `replace`, `other`. |
| `author` | – | Annotation author, if the PDF records it. |
| `comment` | – | The editor's comment body. |
| `anchoredText` | – | Text physically under the markup. Intentionally over-captures the whole line for robust matching. |
| `markedText` | – | The tightly-bounded text actually inside the markup quads — used for character-precise delete/replace. |
| `beforeText` | – | For `insert` (caret) marks: the text left of the caret on the same line, to place the insertion at the exact offset. |
| `geometry` | ✓ | Position in the PDF — see below. |

**`geometry`** declares its coordinate system explicitly so a non-PDF-aware
consumer needs no out-of-band knowledge:

- `page` — **1-based** page number.
- `unit` — `"pt"` (PDF points).
- `origin` — `"bottom-left"` (PDF user space).
- `rect` — bounding box `[x0, y0, x1, y1]`.
- `quadPoints` — *(optional, reserved)* per-line quad points, 8 numbers per
  quad, for markup spanning multiple lines. Not yet emitted.

### `match` — computed (a cache, `null` when unmatched)

The matcher's best mapping of the annotation onto the source. It is
**recomputable** — running *Re-map* rebuilds it — so a consumer must treat it as
a cache, not ground truth.

| Field | Req | Meaning |
| --- | :-: | --- |
| `startLine` / `endLine` | ✓ | **0-based**, inclusive, line range in the source. |
| `score` | ✓ | 0–1 similarity of the matched span. `1` for the deterministic methods. |
| `method` | – | How the mapping was produced — see below. |
| `sourceExcerpt` | – | A snapshot of the matched source text **for display/debug only**. It goes stale the moment the line is edited — never treat it as authoritative. |

`method` splits into two families, and the distinction matters more than the score:

| Method | Family | Meaning |
| --- | --- | --- |
| `marker` | deterministic | An `// eddie:<id>` marker comment was found in the source. |
| `blockId` | deterministic | The enclosing `[#id]` block was found. |
| `fingerprint` | deterministic | The enclosing block hashed to `anchor.blockFingerprint`. |
| `fuzzy` | search | Token/bigram window match. |
| `semantic` | search | Embedding similarity (opt-in, needs Ollama). |
| `lexical` | search | Character-trigram containment. |

The deterministic methods resolve an identity that was *recorded in the source*, so
they are not similarity measurements and always win over the search methods. The
search methods compare the editor's PDF text — which reflects the source as it was
when the editor marked it up — against prose that may since have been rewritten, so
they can and do produce confident-looking wrong answers.

`match` is `null` when nothing cleared the threshold; the item is then
*Unmatched* and awaits a manual link (`state.manualLine`).

### `anchor` — durable source binding (optional)

Where `match` is a recomputed guess, `anchor` records identities that **travel with
the text itself** and therefore survive edits the matcher cannot follow — including
edits made outside the extension, where live position tracking never sees them.

```jsonc
"anchor": {
  "marker": "a3f21c94",
  "blockId": "ch04-figure-anatomy",
  "blockFingerprint": "9c1f4e02aa73b518",
  "contextBefore": "two debts from earlier chapters come due here",
  "contextAfter": "chapter 2 designed a memory system in the abstract"
}
```

| Field | Req | Meaning |
| --- | :-: | --- |
| `marker` | – | Id of the `// eddie:<id>` comment injected into the source. Asciidoctor strips `//` lines before rendering, so a marker never reaches the PDF. |
| `blockId` | – | Id of the enclosing AsciiDoc block (`[#ch04-figure-anatomy]`). Also the way to place a mark on a figure or table, which has no text layer to search. |
| `blockFingerprint` | – | Truncated SHA-256 of the normalized enclosing block at anchor time. |
| `contextBefore` / `contextAfter` | – | A few normalized words either side, for last-ditch re-matching. |

The whole block is omitted for an un-anchored item. Anchors are written only when
the user explicitly runs the anchor command — loading and re-mapping never modify
the source document.

> **Line numbers are 0-based** throughout the format (`match.startLine`,
> `state.manualLine`). Editors that display 1-based line numbers add 1 for
> presentation.

### `state` — user-owned (the only hand-edited block)

| Field | Req | Meaning |
| --- | :-: | --- |
| `resolved` | ✓ | The reviewer has handled this item. |
| `confirmed` | – | The user vouched for the link (hand-picked, or accepted a low-confidence/semantic auto-match). Keeps it out of *Needs review*. |
| `manualLine` | – | **0-based** line the user manually linked to; **overrides** `match`. |
| `note` | – | Free-form reviewer note. |
| `replies` | – | The author's reply thread under this annotation, oldest first. |

The **effective line** of an item is `manualLine` when set, otherwise
`match.startLine`, otherwise unmatched.

Each entry in **`replies`** is the author answering the editor:

```jsonc
{
  "id": "r-7f3a",
  "author": "Volodymyr Pavlyshyn",
  "createdAt": "2026-08-07T10:14:02.000Z",
  "body": "Tightened this — the two debts are now named directly."
}
```

All four fields are required. Replies are authored content, never recomputed: a
re-map carries them across unchanged, and so does the fingerprint-based rescue that
reattaches state when a re-exported PDF re-keys every annotation id.

## Compatibility & migration

- **Reading:** a consumer branches on `version`. Eddie Doc reads `1`, `2` and
  `3`. Unknown top-level fields should be ignored, not rejected.
- **v1 → v2:** version 1 was a flat shape with absolute `adocPath`/`pdfPath` and
  item fields at the top level. Eddie Doc migrates it transparently on load.
- **v2 → v3:** version 2 assumed one sidecar per `.adoc`, so it had nowhere to
  say which round it was or whose marks it held. A v2 file is read as **the sole
  mapping of the document's first round** (`rev-1`), named after its own file
  stem — which is exactly how authors have been reading it. Nothing is lost and
  no user action is required; the next write upgrades the file in place, where
  it already sits. Moving it into the review folder is a separate, explicit
  command (**Move Reviews into Review Folder**), because moving a checked-in file
  is a decision, not a side effect.
- **Items are unchanged** from v2 to v3: `annotation`, `anchor`, `match` and
  `state` are byte-for-byte the same shape. A tool that only reads items needs no
  changes beyond accepting the new `version`.
- **Forward changes:** additive fields do not bump `version`. A breaking change
  to existing fields bumps it to `4`.

## Validating a sidecar

```bash
# any JSON Schema validator, e.g. ajv-cli
npx ajv-cli validate --spec=draft2020 --strict=false \
  -s schema/review-v3.schema.json -d path/to/acme-copyedit.review.json

# every mapping in the project at once
npx ajv-cli validate --spec=draft2020 --strict=false \
  -s schema/review-v3.schema.json -d ".eddie/**/*.review.json"
```

## Relationship to the W3C Web Annotation model

This format is intentionally close to the
[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/): an
`item` is an annotation whose *body* is `annotation.comment` and whose *target*
is the PDF (via `geometry`) plus the source (via `match`/`state`). The mapping is
mechanical — `anchoredText` → `TextQuoteSelector`, `match.startLine` →
`TextPositionSelector`, `geometry` → an FPDF/quad `FragmentSelector` — leaving a
clean path to emit standards-compliant JSON-LD in a future version without
reworking the data captured here.
