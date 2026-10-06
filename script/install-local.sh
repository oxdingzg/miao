#!/usr/bin/env bash
# Install a prebuilt preview without touching the release-managed miao command.
# Compile on a build host, then use: ./script/install-local.sh --binary /path/to/miao
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/share/miao/bin"
LINK="${HOME}/.local/bin/miao-preview"
if [[ "${1:-}" != "--binary" || -z "${2:-}" || $# != 2 ]]; then
  echo 'Usage: ./script/install-local.sh --binary /path/to/prebuilt/miao' >&2
  exit 1
fi
SRC="$2"
VERSION="$("$SRC" --version)"
mkdir -p "$BIN_DIR" "$(dirname "$LINK")"
if [[ -e "$LINK" ]]; then
  PREVIOUS="$(readlink "$LINK")"
  ln -s "$PREVIOUS" "$BIN_DIR/.prev-$$"
  mv -f "$BIN_DIR/.prev-$$" "$BIN_DIR/miao.prev"
fi
MIAO_INSTALL_DIR="$BIN_DIR" bash "$REPO/install" --binary "$SRC" --no-modify-path
ln -s "$(readlink "$BIN_DIR/miao")" "${LINK}.new-$$"
mv -f "${LINK}.new-$$" "$LINK"
echo "Installed miao-preview $VERSION at $LINK"
echo "Rollback: ln -sfn '$BIN_DIR/miao.prev' '$LINK'"
