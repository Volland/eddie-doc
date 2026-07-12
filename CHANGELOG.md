# Changelog

All notable changes to **Eddie Doc — AsciiDoc PDF Review** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
