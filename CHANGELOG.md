# Changelog

All notable changes to **Eddie Doc — AsciiDoc PDF Review** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.8] — 2026-08-02

### Added
- **Matching-quality benchmark** — `npm run bench` runs the real extraction +
  mapping pipeline over hand-verified golden corpora (`sample/*.golden.json`)
  and gates on the result, so matcher changes are measured, not eyeballed.
- **Export Review Report** — a command (and `dist/cli.js … --report`) that
  renders the session as a Markdown report (`<file>.review.md`) grouped into
  Open / Needs review / Unmatched / Resolved — the artifact you send back to
  your editor, with a staleness warning when inputs changed since mapping.
- **Second-round carry-over** — opening a re-exported PDF (which re-keys every
  annotation id) now carries resolved state, notes and manual links over by
  content fingerprint, so a new review round doesn't reset your progress.
- **Lexical fallback tier** (`eddieDoc.lexicalFallback`, on by default) —
  unmatched annotations get a second chance via character-trigram similarity
  against source paragraphs: catches inflected/typo'd wording with zero setup,
  no Ollama required. Tunable via `eddieDoc.lexicalThreshold`.

### Changed
- The semantic (Ollama) fallback now batches embeddings through `/api/embed`
  (with a legacy per-input fallback) and memoizes vectors in a persistent
  content-addressed cache, making re-maps near-instant instead of one HTTP
  round-trip per paragraph.

### Fixed
- Sticky notes parked in the page margin could anchor to a line in the wrong
  paragraph: nearest-line search now measures distance to each text run's
  rectangle (vertically weighted) instead of its centre. Caught by the new
  benchmark.

## [0.1.6] — 2026-07-12

### Added
- **Eddie Doc Review Format v2** — the `<file>.review.json` sidecar is now a
  portable, versioned, schema-validated standard: paths relative to the sidecar,
  SHA-256 content fingerprints for staleness detection, and each item split into
  `annotation` / `match` / `state`. See [docs/FORMAT.md](docs/FORMAT.md) and the
  [JSON Schema](schema/review-v2.schema.json).
- Project website with a plugin intro and the format spec, published via GitHub
  Pages at <https://volland.github.io/eddie-doc/>.

### Changed
- New logo — a cat whose muzzle is a fountain-pen nib — across the activity-bar
  icon, Marketplace icon, and website.
- Version-1 sidecars are migrated to v2 transparently on first write; no user
  action required.

## [0.1.5] — 2026-07-11
- Matching improvements and reliability fixes.

## [0.1.4] — 2026-07-11
- Added the PDF page preview webview.

## [0.1.3] — 2026-07-03
- Matching improvements.

## [0.1.0] — 2026-07-03
- Initial release: extract PDF annotations, fuzzy-map them to AsciiDoc source,
  and review them as tree items, inline decorations, and diagnostics.
