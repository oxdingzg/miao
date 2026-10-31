#!/bin/sh
set -eu
# The hosted macOS image installs several Xcodes and leaves an older one
# selected by default: the macos-15 image keeps Xcode 16.4 active while every
# 26.x release sits unused under /Applications/Xcode_26*.app. The iOS suite has
# only ever run on the owner's build host, which carries a current Xcode, so
# select the newest installed one here rather than inheriting the image default.
if [ "$(uname -s)" != Darwin ]; then
  echo "Not macOS; leaving the toolchain selection alone." >&2
  exit 0
fi

newest=$(
  for candidate in /Applications/Xcode_*.app; do
    [ -d "$candidate" ] && printf '%s\n' "$candidate"
  done | sed 's#/Applications/Xcode_##; s#\.app$##' | sort -V | tail -1
)

if [ -z "$newest" ]; then
  echo "No /Applications/Xcode_*.app found; keeping the current selection." >&2
else
  sudo xcode-select -s "/Applications/Xcode_${newest}.app"
fi

xcodebuild -version
xcrun --sdk iphonesimulator --show-sdk-version
