#!/usr/bin/env bash
#
# One script to cut a new Eddie Doc release. Every run BUMPS the version, so it
# is safe to run repeatedly -- no more "tag already exists" on the second run.
#
#   ./release.sh [patch|minor|major|X.Y.Z] [local|github|marketplace|all]
#
# One release ships both hosts under one version: the .vsix, and the Obsidian
# plugin's main.js / manifest.json / styles.css as separate release assets.
#
# Defaults: bump=patch, target=local.
#   local        bump + build + package + install the .vsix into VS Code
#   github       the above + push commit & tag + create/refresh a GitHub release
#   marketplace  the above + vsce publish (needs VSCE_PAT -- see below)
#   all          github + marketplace
#
# One-time setup for the marketplace target (browser, cannot be scripted):
#   1. Azure DevOps org:  https://dev.azure.com
#   2. Publisher "pavlyshyn": https://marketplace.visualstudio.com/manage/createpublisher
#   3. PAT with scope Marketplace>Manage, then: export VSCE_PAT=<token>
#
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-patch}"
TARGET="${2:-local}"

case "$BUMP" in
  patch|minor|major) ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: ./release.sh [patch|minor|major|X.Y.Z] [local|github|marketplace|all]"; exit 2 ;;
esac
case "$TARGET" in
  local|github|marketplace|all) ;;
  *) echo "unknown target '$TARGET' (local|github|marketplace|all)"; exit 2 ;;
esac

# npm version refuses to run with a dirty tracked tree; fail early with a clear msg.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[x] Uncommitted tracked changes -- commit or stash them first:"
  git status --short
  exit 1
fi

git fetch --tags --quiet 2>/dev/null || true

echo "[1/4] Verifying (core boundary + typecheck + tests)..."
npm run check:core
npm run typecheck
npm test

echo "[2/4] Bumping version ($BUMP)..."
# Don't parse npm's stdout for the tag — lifecycle-hook banners pollute it.
# Bump, then read the authoritative version back from package.json.
npm version "$BUMP" -m "release: v%s" >/dev/null
VERSION="$(node -p "require('./package.json').version")"
NEW_TAG="v$VERSION"
VSIX="eddie-doc-${VERSION}.vsix"
echo "       -> $NEW_TAG"

echo "[3/4] Building + packaging $VSIX and the Obsidian plugin..."
npm run build
npm run verify:obsidian-engine
npm run smoke:obsidian
npx --yes @vscode/vsce package --skip-license -o "$VSIX"
OBSIDIAN_ASSETS=(dist/obsidian/main.js dist/obsidian/manifest.json dist/obsidian/styles.css)
for f in "${OBSIDIAN_ASSETS[@]}"; do [ -f "$f" ] || { echo "[x] missing $f"; exit 1; }; done

echo "[4/4] Publishing (target: $TARGET)..."
want_github=false; want_market=false
case "$TARGET" in
  github) want_github=true ;;
  marketplace) want_market=true ;;
  all) want_github=true; want_market=true ;;
esac

if [ "$TARGET" = "local" ] && command -v code >/dev/null; then
  code --install-extension "$VSIX" --force
fi

if $want_github; then
  command -v gh >/dev/null || { echo "Installing gh..."; brew install gh; }
  if ! gh auth status >/dev/null 2>&1; then
    echo "[x] Not logged in to GitHub. Run 'gh auth login', then re-run:"
    echo "    ./release.sh $VERSION $TARGET   # version already bumped; this reuses it"
    exit 1
  fi
  git push origin HEAD
  git push origin "$NEW_TAG"
  if gh release view "$NEW_TAG" >/dev/null 2>&1; then
    gh release upload "$NEW_TAG" "$VSIX" "${OBSIDIAN_ASSETS[@]}" --clobber
  else
    gh release create "$NEW_TAG" "$VSIX" "${OBSIDIAN_ASSETS[@]}" --title "Eddie Doc $NEW_TAG" --generate-notes
  fi
  echo "       -> $(gh release view "$NEW_TAG" --json url -q .url)"

  # Obsidian (and BRAT) find a plugin release by a tag equal to manifest.json's
  # version with no "v", so the plugin files get a second release under that tag.
  # Pre-release versions (1.4.0-beta.1) are marked as such.
  PRE=""; case "$VERSION" in *-*) PRE="--prerelease" ;; esac
  if gh release view "$VERSION" >/dev/null 2>&1; then
    gh release upload "$VERSION" "${OBSIDIAN_ASSETS[@]}" --clobber
  else
    gh release create "$VERSION" "${OBSIDIAN_ASSETS[@]}" $PRE \
      --title "Eddie Doc $VERSION (Obsidian plugin)" \
      --notes "Obsidian plugin files for Eddie Doc $VERSION (main.js, manifest.json, styles.css). Install with BRAT (Volland/eddie-doc) or copy them into <vault>/.obsidian/plugins/eddie-doc/. The VS Code extension is on release $NEW_TAG." \
      --target "$(git rev-parse HEAD)"
  fi
  echo "       -> $(gh release view "$VERSION" --json url -q .url)"
fi

if $want_market; then
  : "${VSCE_PAT:?Set VSCE_PAT to publish to the Marketplace (see the script header)}"
  npx --yes @vscode/vsce publish --skip-license --packagePath "$VSIX" --pat "$VSCE_PAT"
  echo "       -> https://marketplace.visualstudio.com/items?itemName=pavlyshyn.eddie-doc"
fi

echo "[ok] Done: $NEW_TAG ($TARGET)"
