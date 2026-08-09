#!/usr/bin/env bash
#
# Vendor the built CLI into a manuscript repo so its build pipeline is
# self-contained and does not depend on this checkout being present.
#
#   scripts/vendor-cli.sh <target-dir>
#
# e.g. scripts/vendor-cli.sh ~/Documents/publishing/manning/pavlyshyn/misc/eddie
#
# TWO files are required, not one: src/pdf/extract.ts points pdfjs at
# `pdf.worker.mjs` sitting beside the bundle, so cli.js alone cannot read a PDF.
# A VERSION stamp goes along with them so stamp-pdf.sh can warn when the vendored
# copy has drifted from the extension that wrote the sidecar.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: scripts/vendor-cli.sh <target-dir>" >&2
  exit 2
fi

VERSION="$(node -p "require('./package.json').version")"

echo "[1/2] Building..."
npm run build >/dev/null

echo "[2/2] Vendoring v$VERSION -> $TARGET"
mkdir -p "$TARGET"
cp dist/cli.js "$TARGET/cli.js"
cp dist/pdf.worker.mjs "$TARGET/pdf.worker.mjs"   # required by cli.js at runtime
printf '%s\n' "$VERSION" > "$TARGET/VERSION"

echo "[ok] vendored eddie-doc $VERSION"
ls -la "$TARGET"
