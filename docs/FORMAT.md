# Eddie Doc Review Format

**Version 2** · media type (proposed) `application/vnd.eddie-doc.review+json` ·
schema: [`schema/review-v2.schema.json`](../schema/review-v2.schema.json) ·
canonical URL: <https://volland.github.io/eddie-doc/schema/review-v2.schema.json>

The **review sidecar** is the durable artifact Eddie Doc produces: a
`<file>.review.json` next to your `.adoc` that records every editor annotation
recovered from an annotated PDF, where each maps into the source, and your
review state. It is designed to be **committed to version control**, **diffed**,
and **read by tools other than the VS Code extension** (a CLI, CI gate, or a
different editor).

This document is the normative spec. The JSON Schema is authoritative for
structure; where prose and schema disagree, the schema wins.

## Design goals

1. **Portable** — no absolute paths. A sidecar checked into a repo works on any
   machine and any clone.
2. **Verifiable** — content fingerprints let a consumer detect that the source
   or PDF changed since mapping ran, without re-running the matcher.
3. **Layered** — each item separates what came *from the PDF* (immutable), what
   the *matcher computed* (a recomputable cache), and what the *user owns*
   (review state). Only the last is hand-edited; the first two are regenerated.
4. **Evolvable** — a top-level integer `version` and a `$schema` URL, so
   consumers can branch on format and validate.

## Top-level shape

```jsonc
{
  "$schema": "https://volland.github.io/eddie-doc/schema/review-v2.schema.json",
  "version": 2,
  "producer": { "name": "eddie-doc", "version": "0.1.5" },
  "createdAt": "2026-07-03T07:15:17.937Z",
  "updatedAt": "2026-07-12T09:02:00.000Z",
  "source": { "path": "chapter-01.adoc", "sha256": "…", "bytes": 4213 },
  "pdf":    { "path": "chapter-01.annotated.pdf", "sha256": "…", "annotationCount": 5 },
  "items":  [ /* … */ ]
}
```

| Field | Req | Meaning |
| --- | :-: | --- |
| `$schema` | – | Format identifier; also the canonical schema URL. |
| `version` | ✓ | On-disk format version. `2` for this spec. |
| `producer` | – | Tool that wrote the file (`name`, optional `version`). |
| `createdAt` / `updatedAt` | ✓ | ISO-8601 timestamps. |
| `source` | ✓ | The `.adoc` input — see [File references](#file-references). |
| `pdf` | ✓ | The annotated PDF input, plus `annotationCount`. |
| `items` | ✓ | The review items — see [Items](#items). |

### File references

Both `source` and `pdf` are **file references**:

```jsonc
{ "path": "chapter-01.adoc", "sha256": "e3b0c4…", "bytes": 4213 }
```

- **`path`** — relative to the **sidecar's own directory**, always with POSIX
  (`/`) separators, even on Windows. Consumers resolve it against the directory
  the sidecar lives in. (Eddie Doc always binds the sidecar to the `.adoc` it
  was opened next to; `source.path` is informational and normally `"<name>.adoc"`.)
- **`sha256`** — hex SHA-256 of the file's bytes at the time mapping last ran.
  Optional (a session migrated from v1 has none until it re-maps). When present,
  a consumer can compare it against the current file to decide whether the
  matches are stale.
- **`bytes`** — size at map time. `pdf` additionally carries **`annotationCount`**,
  a cheap staleness signal.

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
| `score` | ✓ | 0–1 similarity of the matched span. |
| `method` | – | `"fuzzy"` (token/bigram) or `"semantic"` (embedding fallback). |
| `sourceExcerpt` | – | A snapshot of the matched source text **for display/debug only**. It goes stale the moment the line is edited — never treat it as authoritative. |

`match` is `null` when nothing cleared the threshold; the item is then
*Unmatched* and awaits a manual link (`state.manualLine`).

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

The **effective line** of an item is `manualLine` when set, otherwise
`match.startLine`, otherwise unmatched.

## Compatibility & migration

- **Reading:** a consumer branches on `version`. Eddie Doc reads both `1` and
  `2`. Unknown top-level fields should be ignored, not rejected.
- **v1 → v2:** version 1 was a flat shape with absolute `adocPath`/`pdfPath` and
  item fields at the top level. Eddie Doc migrates a v1 sidecar transparently on
  load; the **next write upgrades the file to v2** (paths relativized,
  fingerprints filled on the next re-map). No user action required.
- **Forward changes:** additive fields do not bump `version`. A breaking change
  to existing fields bumps it to `3`.

## Validating a sidecar

```bash
# any JSON Schema validator, e.g. ajv-cli
npx ajv-cli validate -s schema/review-v2.schema.json -d path/to/chapter-01.review.json
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
