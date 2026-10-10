#!/usr/bin/env bash
# Install a locally built miao-engine without touching the release-managed miao
# command or the miao-preview build. Compile on a build host, then:
#   ./script/install-engine.sh --binary /path/to/miao-engine
#
# Keeps one previous install for a one-step rollback and smoke-tests --version.
set -euo pipefail
BIN_DIR="${HOME}/.local/share/miao-engine/bin"
LINK="${HOME}/.local/bin/miao-engine"
if [[ "${1:-}" != "--binary" || -z "${2:-}" || $# != 2 ]]; then
  echo 'Usage: ./script/install-engine.sh --binary /path/to/miao-engine' >&2
  exit 1
fi
SRC="$2"
if [[ ! -x "$SRC" ]]; then
  echo "not an executable: $SRC" >&2
  exit 1
fi
VERSION="$("$SRC" --version)"
if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "$SRC" | cut -d' ' -f1)"
else
  HASH="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
fi
mkdir -p "$BIN_DIR" "$(dirname "$LINK")"
TARGET="$BIN_DIR/${VERSION// /-}-${HASH}"
# A version can have several preview builds. Content-addressed targets keep the
# previous binary intact even when both builds report the same version.
# Publish the new binary, then remember the one it replaces.
cp -f "$SRC" "${TARGET}.new-$$"
chmod +x "${TARGET}.new-$$"
mv -f "${TARGET}.new-$$" "$TARGET"
if [[ -L "$LINK" && "$(readlink "$LINK")" != "$TARGET" ]]; then
  ln -sfn "$(readlink "$LINK")" "$BIN_DIR/miao-engine.prev.tmp-$$"
  mv -f "$BIN_DIR/miao-engine.prev.tmp-$$" "$BIN_DIR/miao-engine.prev"
fi
# Repoint atomically, then verify the installed command before announcing it.
ln -sfn "$TARGET" "${LINK}.new-$$"
mv -f "${LINK}.new-$$" "$LINK"
"$LINK" --version >/dev/null
echo "Installed $VERSION at $LINK"
if [[ -L "$BIN_DIR/miao-engine.prev" ]]; then
  echo "Rollback: ln -sfn '$(readlink "$BIN_DIR/miao-engine.prev")' '$LINK'"
fi
