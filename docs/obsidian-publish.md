# Publishing the Obsidian plugin

What is ready, what is not, and the exact steps. Releases `1.4.0-beta.1` and `1.4.0` have been cut; the community directory submission has not been made.

## Released: 1.4.0-beta.1 (2026-10-05)

A pre-release is on GitHub and installs through BRAT today.

| | |
| --- | --- |
| Obsidian files (what BRAT and Obsidian read) | <https://github.com/Volland/eddie-doc/releases/tag/1.4.0-beta.1>: `main.js`, `manifest.json`, `styles.css` |
| VS Code build and the same files | <https://github.com/Volland/eddie-doc/releases/tag/v1.4.0-beta.1>: the `.vsix` too. Not on the Marketplace |
| Checked after publishing | CI and the release workflow passed on GitHub; the three downloaded files are byte-identical to the local build; `E2E_PLUGIN_DIR=<downloaded files> npm run e2e:obsidian` passes 65 of 65 on Obsidian 1.8.4 |
| Not done | Measured phone testing; the community directory submission; the VS Code Marketplace |

**Try it in Obsidian:** install the BRAT community plugin, then *BRAT → Add beta plugin* → `Volland/eddie-doc`, enable *Eddie Doc*. On a phone, do the same inside the mobile app, or copy the three files into `<vault>/.obsidian/plugins/eddie-doc/` through your sync. Then run *Eddie Doc: Open PDF review* on a PDF and `.adoc` in the vault.

**Promoted:** after the maintainer tried it on a phone, `./release.sh 1.4.0 github` cut the stable release (see below), and section 2 is the next step.

## Where it stands

| | State |
| --- | --- |
| Code, build, tests | Done. `npm test` (362), `npm run check:core`, `npm run test:obsidian` pass |
| Manifest and versions | Done. `manifest.json` and `versions.json` at the repo root, kept on the package version by `npm version` |
| README, guide, licence, privacy | Done. `README.md`, `docs/OBSIDIAN.md` (network use, no telemetry), `LICENSE` (MIT) |
| Release automation | In use since 1.4.0: `release.sh` verifies, bumps, tags and pushes; `.github/workflows/release.yml` builds from a clean checkout, **attests** every release file (GitHub artifact attestation) and publishes. Attestations exist from 1.4.2 |
| Plugin id and name | Free. Checked against the community list (8,424 plugins) on 2026-10-05: no `eddie-doc` id, no "Eddie Doc" name. Re-check at submission time |
| **Run in a real Obsidian** | **Desktop done, phone not.** `npm run e2e:obsidian` passes 65 of 65 on Obsidian 1.8.4 and 1.13.7 (macOS), including the AsciiDoc Live pairing. `docs/obsidian-qa.md` has not been run by a person on any platform, and nothing has run on iOS or Android |
| **Mobile spike** | **Not done.** `docs/obsidian-spike-results.md` records the desktop answers; the phone rows are empty |

The phone is the reason to hold back the community submission, and a person's pass through the QA checklist is the other. Everything else is mechanical.

## Gate before any release

Run `npm run e2e:obsidian` (it passes today) and then `docs/obsidian-qa.md` by hand on at least one desktop and one phone, recording the results in its table. Settle these from the spike file, because they decide whether claims in the README are true:

1. ~~Does Obsidian accept a Markdown view for a `.adoc` whose extension AsciiDoc Live registered?~~ Yes, on 1.8.4 and 1.13.7.
2. ~~Does the built-in PDF viewer honour `#page=N&rect=…`?~~ No, on 1.8.4; Eddie's viewer is the default.
3. **Still open:** does the plugin map the sample PDF on a phone, and does a ~300-page PDF finish? (If not, say so in the README and consider turning mapping off on mobile.)
4. **Still open:** does Eddie's own viewer draw on a phone, and how fast?

If a check fails, fix the code or soften the matching sentence in `docs/OBSIDIAN.md` before releasing. The status box at the top of that file now says what was and was not checked; rewrite it when the QA table changes the answer.

## 1. Pre-release through BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs a plugin straight from a GitHub release, so testers need no store listing.

```bash
git status                       # clean tracked tree; release.sh refuses otherwise
./release.sh 1.4.0-beta.1 github # or: patch | minor | major
```

`release.sh` bumps the version (`package.json`, `manifest.json`, `versions.json`, the sidecar producer stamp), builds both products to check they build, runs the Obsidian engine check and smoke test, and pushes the commit and tag. Pushing the tag starts the Release workflow, which is the **only** thing that publishes: it rebuilds from a clean checkout, attests the files, and creates two releases:

| Release | Tag | Contains | Why |
| --- | --- | --- | --- |
| VS Code | `v1.4.0-beta.1` | the `.vsix`, plus the three Obsidian files | what this repo has always published |
| Obsidian | `1.4.0-beta.1` | `main.js`, `manifest.json`, `styles.css` | Obsidian and BRAT look a plugin release up by a tag equal to the manifest version, with no `v` |

A version containing `-` is marked as a pre-release. Pushing the `v` tag also starts `.github/workflows/release.yml`, which does the same from a clean checkout and fails if the tag, `package.json` and `manifest.json` disagree. Either path can create the releases; the other updates them rather than failing.

**Attestations.** The community directory recommends GitHub artifact attestations on the release files, so users can verify a downloaded file was built from this repository. The workflow attests `main.js`, `manifest.json`, `styles.css` and the `.vsix` before uploading them (it has `id-token: write` and `attestations: write` for that). Check one with:

```bash
gh attestation verify main.js --repo Volland/eddie-doc
```

A file can only be attested by the workflow that built it, which is why `release.sh` no longer uploads anything itself. Releases `1.4.0`–`1.4.1` were uploaded without attestations; `1.4.2` is the first with them.

If you would rather have only one tag style, switch the repository to tags without `v` (change `NEW_TAG` in `release.sh` and the trigger in `release.yml`); the VS Code side does not care.

Then, in Obsidian with BRAT installed: *BRAT → Add beta plugin* → `Volland/eddie-doc`. Check that the three files arrive in `<vault>/.obsidian/plugins/eddie-doc/` and the plugin enables.

## 2. Submit to the community directory

**Submission no longer goes through a pull request.** The official instructions (<https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>) describe a web dashboard and do not mention a pull request to `obsidianmd/obsidian-releases`, and that repository's pull-request list is not available through the API. This guide was first written for the old pull-request flow and has been corrected; check the page above for any change before submitting.

Do this only after the gate above and at least one stable release (`1.4.0` or later, not a beta). Obsidian installs from the release whose tag equals the version in `manifest.json` (no `v`), so the plugin must be installable from that release's three files.

1. Check the repository has what the directory reads: `README.md`, `LICENSE`, and `manifest.json` (semantic version `x.y.z`, a release tagged with exactly that version carrying `main.js`, `manifest.json` and `styles.css`). All are in place for `1.4.0`.
2. Sign in at <https://community.obsidian.md> with your Obsidian account and link your GitHub account to your profile. This needs you; it cannot be done on your behalf.
3. Use **Add your plugin** and choose `Volland/eddie-doc`.
4. The directory runs an automated review of `manifest.json` and the release. Fix anything it reports in the repository and publish a **new, higher version** (`./release.sh patch github`); do not edit a published release.

The old entry format (`id`, `name`, `author`, `description`, `repo`) is now read from `manifest.json` and the repository rather than typed in.

### Requirements, and where Eddie Doc stands

| Requirement | Status |
| --- | --- |
| `manifest.json` at the repo root with `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly` | Met. `minAppVersion` is 1.7.2: the newest API called is the promise form of `Workspace.revealLeaf`, added in 1.7.2 |
| `id` without "obsidian", lowercase; `description` under 250 characters, ending with a full stop, no "Obsidian" | Met (101 characters) |
| `README.md` in the repo root describing what it does | Met. The root README introduces both hosts and links `docs/OBSIDIAN.md` |
| `LICENSE` | Met (MIT) |
| Release tag equals `manifest.json` version, with `main.js` and `manifest.json` (and `styles.css`) attached as assets | Met by the workflow and `release.sh`; verify on the first real release |
| Disclose network use, file access outside the vault, accounts, ads, telemetry | Disclosed in `docs/OBSIDIAN.md` ("Privacy"): the only network feature is the optional Ollama fallback, desktop only, off by default, to the URL the user sets; no telemetry. Copying a PDF in from disk is user-initiated through a file picker. **Add a short disclosure to the root README before submitting**: reviewers read that file |
| Works on mobile if `isDesktopOnly` is false | **Unverified on a phone.** Emulated layout and platform checks pass. See the gate |
| No `eval`, remote code, or unnecessary minification of the plugin's own code | The bundle contains `new Function` only inside pdfjs (feature detection and PostScript functions), which is disabled by passing `isEvalSupported: false`. The plugin's own code has none: the main-thread worker fallback loads a script from a Blob instead. Expect a reviewer question; the answer is that these are pdfjs internals |
| Use `activeDocument` / `activeWindow`, `setCssStyles`, no `innerHTML`, no `localStorage`, clean `onunload` | Met in `src/hosts/obsidian` (checked by a scan on 2026-10-05). Unload is untested in a real app |
| Do not put the plugin name in command names; no default hotkeys | Met |
| Bundle size | 2.2 MB: pdfjs (about 1.3 MB) and its worker, which cannot be loaded from a file on mobile |
| Desktop-only features declared | Semantic fallback and "Import a PDF from outside the vault" are hidden or refused on mobile |

### Things a reviewer may raise

- **Reading and writing files.** Eddie uses the vault adapter for the review folder (so it works on dot-folders and on mobile) and the vault API for files Obsidian has indexed. It writes only inside the review folder and the manuscript it was asked to anchor or edit.
- **Writing into your notes.** `// eddie:<id>` anchor comments are added to the `.adoc` on mapping, which is on by default. This is disclosed in the guide and the settings text; consider whether the default should be off for a first release.
- **Claiming a file extension.** `.adoc` and `.asciidoc` are registered only when no other plugin holds them, after all plugins load, with a setting to opt out. Reviewers have asked about this pattern before; ADR 0002 records why.
- **Existing plugins.** AsciiDoc Live, Asciidoc Reader, Asciidoctor editor and AsciiDoc Blocks exist. Eddie does not render AsciiDoc, and says so, so there is no overlap in purpose.

## 3. After a release

- Bump with `./release.sh patch github`. Never edit a published release's files: Obsidian caches by version.
- `versions.json` maps each plugin version to its minimum Obsidian version; the hook adds a line per release. If `minAppVersion` ever rises, older Obsidians keep the last compatible release.
- Keep `CHANGELOG.md` current; the release notes are generated from commits, the changelog is the human-written record.

## Open work

The OpenSpec change `obsidian-plugin` was archived with 24 of its 80 tasks open (`openspec/changes/archive/*-obsidian-plugin/tasks.md` has each, with its status). The ones that matter, in the order to do them:

1. **Phone verification** (spike 1.1–1.8, QA 6.21). Desktop Obsidian is covered by `npm run e2e:obsidian`; what remains needs a phone and a real vault: build the 300-page fixture, run `docs/obsidian-qa.md` on iOS and Android, fill in the phone rows of `docs/obsidian-spike-results.md`. A person's pass through the checklist on desktop (looks, sync) is also still owed.
2. **Run the VS Code manual checklist** (4.7). The refactor changed how the extension talks to its store; automated checks pass and the built extension activates under a stub, but it has not been used in VS Code since.
3. **Submit to the community directory** through the dashboard (section 2), then answer whatever its automated review reports.
4. **Smaller, optional:** have the VS Code UI use `core/view` and `core/edits` instead of its own copies (2.17); split `extension.ts` into commands and flows (4.3); a VS Code host test (4.6); verify clean unload (6.20); spike-derived `Capabilities` flags (6.6).
5. **The main specs are not written.** The delta specs were archived with the change, not merged into `openspec/specs/`, because merging would present unverified Obsidian behavior as established. After the QA pass, sync the requirements that held up.

## Decisions for the owner

1. **Release tags.** Keep two (`vX.Y.Z` and `X.Y.Z`) or move the whole repo to bare `X.Y.Z`? Two is what is set up.
2. **Auto-anchor default.** Writing `// eddie:` comments into a user's manuscript on import is the useful default for VS Code. For a first Obsidian release a more cautious default (off, with a prompt) may suit reviewers better.
3. **Mobile mapping.** If the phone spike shows large PDFs fail, ship with mobile limited to reviewing (read, reply, resolve, apply) and document it, rather than shipping a mapping button that crashes.
4. **Who reviews.** The community review is by Obsidian's team; do the BRAT round with a few real users first.
