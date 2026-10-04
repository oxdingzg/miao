#!/bin/sh
# Build the current checkout as a preview binary and install it as
# `miao-preview`, so it never shadows the release-managed `miao` command.
# The previous preview install is kept for one-step rollback.
#
#   ./script/install-local.sh
#
# Rollback:  ln -sfn "$HOME/.local/share/miao/bin/miao.prev" "$HOME/.local/bin/miao-preview"
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/share/miao/bin"
LINK="${HOME}/.local/bin/miao-preview"

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

mkdir -p "${BIN_DIR}" "$(dirname "${LINK}")"

if [ -e "${LINK}" ] || [ -L "${LINK}" ]; then
  rm -f "${BIN_DIR}/miao.prev"
  cp -RL "${LINK}" "${BIN_DIR}/miao.prev" 2>/dev/null || true
fi

TARGET="${BIN_DIR}/miao-${VERSION}"
cp "${SRC}" "${TARGET}"
chmod +x "${TARGET}"
ln -sfn "${TARGET}" "${LINK}"

# Keep the three newest versioned installs; miao.prev is preserved for rollback.
ls -1t "${BIN_DIR}"/miao-* 2>/dev/null | tail -n +4 | while read -r stale; do
  rm -f "${stale}"
done

echo "==> installed"
echo "    ${LINK} -> $(readlink "${LINK}" 2>/dev/null || echo "${TARGET}")"
echo "    rollback: ln -sfn \"${BIN_DIR}/miao.prev\" \"${LINK}\""
