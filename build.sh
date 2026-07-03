#!/usr/bin/env bash
#
# Build + package the extension at its CURRENT version (no version bump).
# Produces eddie-doc-<version>.vsix in the project root and prints its path.
#
#   ./build.sh            # typecheck + tests + build + package
#   ./build.sh --fast     # skip typecheck + tests (build + package only)
#
set -euo pipefail
cd "$(dirname "$0")"

FAST=false
[ "${1:-}" = "--fast" ] && FAST=true

VERSION="$(node -p "require('./package.json').version")"
VSIX="eddie-doc-${VERSION}.vsix"

if ! $FAST; then
  echo "[1/3] Verifying (typecheck + tests)..."
  npm run typecheck
  npm test
fi

echo "[2/3] Building..."
npm run build

echo "[3/3] Packaging $VSIX..."
npx --yes @vscode/vsce package --skip-license -o "$VSIX"

echo "[ok] Built $VSIX"
# Last line is the artifact path so other scripts can capture it.
echo "$VSIX"
