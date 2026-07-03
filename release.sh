#!/usr/bin/env bash
#
# One script to cut a new Eddie Doc release. Every run BUMPS the version, so it
# is safe to run repeatedly -- no more "tag already exists" on the second run.
#
#   ./release.sh [patch|minor|major|X.Y.Z] [local|github|marketplace|all]
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

echo "[1/4] Verifying (typecheck + tests)..."
npm run typecheck
npm test

echo "[2/4] Bumping version ($BUMP)..."
NEW_TAG="$(npm version "$BUMP" -m "release: v%s")"   # commits + tags vX.Y.Z, prints it
VERSION="${NEW_TAG#v}"
VSIX="eddie-doc-${VERSION}.vsix"
echo "       -> $NEW_TAG"

echo "[3/4] Building + packaging $VSIX..."
npm run build
npx --yes @vscode/vsce package --skip-license -o "$VSIX"

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
    gh release upload "$NEW_TAG" "$VSIX" --clobber
  else
    gh release create "$NEW_TAG" "$VSIX" --title "Eddie Doc $NEW_TAG" --generate-notes
  fi
  echo "       -> $(gh release view "$NEW_TAG" --json url -q .url)"
fi

if $want_market; then
  : "${VSCE_PAT:?Set VSCE_PAT to publish to the Marketplace (see the script header)}"
  npx --yes @vscode/vsce publish --skip-license --packagePath "$VSIX" --pat "$VSCE_PAT"
  echo "       -> https://marketplace.visualstudio.com/items?itemName=pavlyshyn.eddie-doc"
fi

echo "[ok] Done: $NEW_TAG ($TARGET)"
