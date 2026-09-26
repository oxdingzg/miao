#!/bin/sh
# Build the current platform's miao binary and install it as the daily `miao`
# command, keeping the previous install for one-step rollback.
#
#   ./script/install-local.sh
#
# Rollback:  ln -sfn "$HOME/.local/share/miao/bin/miao.prev" "$HOME/.local/bin/miao"
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/share/miao/bin"
LINK="${HOME}/.local/bin/miao"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
esac
NAME="miao-${OS}-${ARCH}"
SRC="${REPO}/packages/miao/dist/${NAME}/bin/miao"

echo "==> building ${NAME}"
bun run --cwd "${REPO}/packages/miao" script/build.ts --single --skip-install --skip-embed-web-ui

echo "==> smoke test"
VERSION="$("${SRC}" --version)"
echo "    version: ${VERSION}"

mkdir -p "${BIN_DIR}"

if [ -e "${LINK}" ] || [ -L "${LINK}" ]; then
  rm -f "${BIN_DIR}/miao.prev"
  cp -RL "${LINK}" "${BIN_DIR}/miao.prev" 2>/dev/null || true
fi

TARGET="${BIN_DIR}/miao-${VERSION}"
cp "${SRC}" "${TARGET}"
chmod +x "${TARGET}"
ln -sfn "${TARGET}" "${LINK}"

echo "==> installed"
echo "    ${LINK} -> $(readlink "${LINK}" 2>/dev/null || echo "${TARGET}")"
echo "    rollback: ln -sfn \"${BIN_DIR}/miao.prev\" \"${LINK}\""
