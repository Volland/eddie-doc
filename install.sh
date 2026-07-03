#!/usr/bin/env bash
#
# Build, package, and install the extension into VS Code at its current version.
#
#   ./install.sh          # full build + install
#   ./install.sh --fast   # skip typecheck + tests, then install
#
set -euo pipefail
cd "$(dirname "$0")"

command -v code >/dev/null || {
  echo "[x] The 'code' CLI is not on PATH."
  echo "    In VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'."
  exit 1
}

# build.sh prints the .vsix path as its last line.
VSIX="$(./build.sh "${1:-}" | tail -n1)"

echo "Installing $VSIX into VS Code..."
code --install-extension "$VSIX" --force

echo "[ok] Installed $VSIX. Reload VS Code (Cmd+Shift+P -> 'Developer: Reload Window')."
