## Purpose

Specifies how the Obsidian plugin is built, versioned and distributed: bundle layout, manifest, release assets, BRAT installation and community-list submission, sharing one version with the VS Code extension.

## ADDED Requirements

### Requirement: Plugin identity and manifest
The plugin SHALL have id `eddie-doc`, name "Eddie Doc", `minAppVersion` `1.7.2`, `isDesktopOnly` false, an author and description, and a `version` equal to the package version.

#### Scenario: Manifest content
- **WHEN** `dist/obsidian/manifest.json` is read after a build
- **THEN** it contains `"id": "eddie-doc"`, `"name": "Eddie Doc"`, `"minAppVersion": "1.7.2"`, `"isDesktopOnly": false` and the package version

### Requirement: Build output
The production build SHALL emit `dist/obsidian/main.js`, `dist/obsidian/manifest.json` and `dist/obsidian/styles.css`, with `obsidian`, `electron` and the `@codemirror/*` and `@lezer/*` packages left external, and the bundle free of Node built-in imports.

#### Scenario: Bundle has no Node built-ins
- **WHEN** the built `main.js` is scanned for `require("fs")`, `require("node:` and `require("path")`
- **THEN** none is found

#### Scenario: Output files
- **WHEN** the production build completes
- **THEN** all three files exist in `dist/obsidian/`

### Requirement: Single shared version
The VS Code extension, CLI, sidecar producer stamp and Obsidian plugin SHALL share one version number set by one release command, and `manifest.json` and `versions.json` SHALL be updated by it.

#### Scenario: Release bump
- **WHEN** the release script bumps the version to 1.4.0
- **THEN** `package.json`, `manifest.json` and `versions.json` (mapping `1.4.0` to `1.7.2`) all reflect it and the producer stamp in sidecars reads 1.4.0

### Requirement: GitHub release assets
A GitHub release SHALL attach `main.js`, `manifest.json` and `styles.css` as individual assets alongside the VS Code `.vsix`, and the release tag SHALL equal the manifest version with no `v` prefix requirement beyond what Obsidian's installer accepts.

#### Scenario: Release upload
- **WHEN** the release script publishes to GitHub
- **THEN** the release lists `main.js`, `manifest.json` and `styles.css` as downloadable assets

### Requirement: BRAT installation first
The plugin SHALL be installable via BRAT from the GitHub repository using the release assets, and documented as such, before submission to the community list.

#### Scenario: Install via BRAT
- **WHEN** a user adds the repository in BRAT
- **THEN** BRAT installs `main.js`, `manifest.json` and `styles.css` and the plugin can be enabled

### Requirement: Community plugin submission readiness
Before submission the repository SHALL satisfy the community-list requirements: a README describing function and network use (Ollama is local and opt-in), a LICENSE, no remote code loading, no telemetry, and the plugin id and name free of conflicts.

#### Scenario: Network use disclosed
- **WHEN** the README is read
- **THEN** it states that the only network access is the opt-in local Ollama request

### Requirement: Obsidian development workflow
The repository SHALL provide a documented way to develop against a test vault (watch build copying output to a vault's plugin folder).

#### Scenario: Watch build
- **WHEN** a developer runs the Obsidian watch build with a vault path configured
- **THEN** rebuilt files appear in that vault's `.obsidian/plugins/eddie-doc/`
