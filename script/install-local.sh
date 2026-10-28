#!/usr/bin/env bash
# Install a prebuilt preview without touching the release-managed miao command.
# Compile on a build host, then use: ./script/install-local.sh --binary /path/to/miao
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${MIAO_PREVIEW_INSTALL_DIR:-${HOME}/.local/share/miao/bin}"
LINK="${MIAO_PREVIEW_LINK:-${HOME}/.local/bin/miao-preview}"
usage() {
  echo 'Usage: ./script/install-local.sh --binary /path/to/prebuilt/miao [--engine-binary /path/to/prebuilt/miao-engine] [--tui-binary /path/to/prebuilt/miao-tui]' >&2
  exit 1
}
if [[ "${1:-}" != "--binary" || -z "${2:-}" ]]; then usage; fi
SRC="$2"
shift 2
ENGINE=""
TUI=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 && -n "$2" ]] || usage
  case "$1" in
    --engine-binary)
      [[ -z "$ENGINE" ]] || usage
      ENGINE="$2"
      ;;
    --tui-binary)
      [[ -z "$TUI" ]] || usage
      TUI="$2"
      ;;
    *) usage ;;
  esac
  shift 2
done
VERSION="$("$SRC" --version)"
if [[ -n "$ENGINE" ]]; then
  [[ "$("$ENGINE" --version)" == "miao-engine $VERSION" ]] || { echo 'Preview CLI and engine versions must match' >&2; exit 1; }
  "$ENGINE" --capabilities >/dev/null
fi
if [[ -n "$TUI" ]]; then
  [[ "$("$TUI" --version)" == "miao-tui $VERSION" ]] || { echo 'Preview CLI and TUI versions must match' >&2; exit 1; }
fi
mkdir -p "$BIN_DIR" "$(dirname "$LINK")"
if [[ -e "$LINK" ]]; then
  PREVIOUS="$(readlink "$LINK")"
  ln -s "$PREVIOUS" "$BIN_DIR/.prev-$$"
  mv -f "$BIN_DIR/.prev-$$" "$BIN_DIR/miao.prev"
fi
MIAO_INSTALL_DIR="$BIN_DIR" bash "$REPO/install" --binary "$SRC" --no-modify-path
TARGET="$(readlink "$BIN_DIR/miao")"
pair_binary() {
  local name="$1" source="$2"
  local paired="$(dirname "$TARGET")/$name"
  local staged="${paired}.new-$$"
  cp "$source" "$staged"
  chmod 755 "$staged"
  if ! ln "$staged" "$paired" 2>/dev/null; then
    cmp -s "$staged" "$paired" || { rm -f "$staged"; echo "Conflicting $name for retained preview build" >&2; exit 1; }
  fi
  rm -f "$staged"
}
if [[ -n "$ENGINE" ]]; then pair_binary miao-engine "$ENGINE"; fi
if [[ -n "$TUI" ]]; then pair_binary miao-tui "$TUI"; fi
ln -s "$TARGET" "${LINK}.new-$$"
mv -f "${LINK}.new-$$" "$LINK"
echo "Installed miao-preview $VERSION at $LINK"
echo "Rollback: ln -sfn '$BIN_DIR/miao.prev' '$LINK'"
