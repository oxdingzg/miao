#!/usr/bin/env bash
# Install a miao-engine without touching the release-managed miao command or
# the miao-preview build. Two sources:
#   ./script/install-engine.sh --binary /path/to/miao-engine   (a local build;
#     compile on a build host first)
#   ./script/install-engine.sh --release [tag]                 (the GitHub
#     release channel; tag defaults to latest, checksum verified)
#
# Keeps one previous install for a one-step rollback and smoke-tests --version.
set -euo pipefail
BIN_DIR="${HOME}/.local/share/miao-engine/bin"
LINK="${HOME}/.local/bin/miao-engine"
MODE="${1:-}"
SRC=""
if [[ "$MODE" == "--release" ]]; then
  TAG="${2:-latest}"
  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS" in Darwin) OS_TAG=darwin ;; Linux) OS_TAG=linux ;; *) echo "unsupported os: $OS" >&2; exit 1 ;; esac
  case "$ARCH" in arm64|aarch64) ARCH_TAG=arm64 ;; x86_64) ARCH_TAG=x64 ;; *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; esac
  ASSET="miao-engine-${OS_TAG}-${ARCH_TAG}.tar.gz"
  BASE="https://github.com/oxdingzg/miao/releases"
  if [[ "$TAG" == "latest" ]]; then
    URL="$BASE/latest/download/$ASSET"
    SHAS_URL="$BASE/latest/download/$ASSET.sha256"
  else
    URL="$BASE/download/$TAG/$ASSET"
    SHAS_URL="$BASE/download/$TAG/$ASSET.sha256"
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$URL" -o "$TMP/$ASSET"
  if curl -fsSL "$SHAS_URL" -o "$TMP/$ASSET.sha256"; then
    (cd "$TMP" && (sha256sum -c "$ASSET.sha256" >/dev/null 2>&1 || shasum -a 256 -c "$ASSET.sha256" >/dev/null 2>&1)) || {
      echo "checksum mismatch for $ASSET" >&2
      exit 1
    }
  else
    echo "no checksum manifest for $ASSET; skipping verification" >&2
  fi
  tar -xzf "$TMP/$ASSET" -C "$TMP"
  SRC="$TMP/miao-engine"
elif [[ "$MODE" == "--binary" ]]; then
  [[ -z "${2:-}" || $# != 2 ]] && { echo 'Usage: ./script/install-engine.sh --binary /path/to/miao-engine' >&2; exit 1; }
  SRC="$2"
else
  echo 'Usage: ./script/install-engine.sh (--binary /path/to/miao-engine | --release [tag])' >&2
  exit 1
fi
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
