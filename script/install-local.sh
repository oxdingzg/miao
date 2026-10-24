#!/usr/bin/env bash
# Install a prebuilt preview without touching the release-managed miao command.
# Compile on a build host, then use: ./script/install-local.sh --binary /path/to/miao
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${MIAO_PREVIEW_INSTALL_DIR:-${HOME}/.local/share/miao/bin}"
LINK="${MIAO_PREVIEW_LINK:-${HOME}/.local/bin/miao-preview}"
if [[ "${1:-}" != "--binary" || -z "${2:-}" || ( $# != 2 && $# != 4 ) || ( $# == 4 && "${3:-}" != "--engine-binary" ) ]]; then
  echo 'Usage: ./script/install-local.sh --binary /path/to/prebuilt/miao [--engine-binary /path/to/prebuilt/miao-engine]' >&2
  exit 1
fi
SRC="$2"
VERSION="$("$SRC" --version)"
ENGINE="${4:-}"
if [[ -n "$ENGINE" ]]; then
  [[ "$("$ENGINE" --version)" == "miao-engine $VERSION" ]] || { echo 'Preview CLI and engine versions must match' >&2; exit 1; }
  "$ENGINE" --capabilities >/dev/null
fi
mkdir -p "$BIN_DIR" "$(dirname "$LINK")"
if [[ -e "$LINK" ]]; then
  PREVIOUS="$(readlink "$LINK")"
  ln -s "$PREVIOUS" "$BIN_DIR/.prev-$$"
  mv -f "$BIN_DIR/.prev-$$" "$BIN_DIR/miao.prev"
fi
MIAO_INSTALL_DIR="$BIN_DIR" bash "$REPO/install" --binary "$SRC" --no-modify-path
TARGET="$(readlink "$BIN_DIR/miao")"
if [[ -n "$ENGINE" ]]; then
  PAIRED="$(dirname "$TARGET")/miao-engine"
  STAGED="${PAIRED}.new-$$"
  cp "$ENGINE" "$STAGED"
  chmod 755 "$STAGED"
  if ! ln "$STAGED" "$PAIRED" 2>/dev/null; then
    cmp -s "$STAGED" "$PAIRED" || { rm -f "$STAGED"; echo 'Conflicting engine for retained preview build' >&2; exit 1; }
  fi
  rm -f "$STAGED"
fi
ln -s "$TARGET" "${LINK}.new-$$"
mv -f "${LINK}.new-$$" "$LINK"
echo "Installed miao-preview $VERSION at $LINK"
echo "Rollback: ln -sfn '$BIN_DIR/miao.prev' '$LINK'"
