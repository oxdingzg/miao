#!/bin/sh
set -eu
# Run on an approved macOS build host. Signing configuration stays outside this repository.
ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$ios_root/../.." && pwd)
miao_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo_root/package.json")
exec xcodebuild -project "$ios_root/Miao.xcodeproj" -scheme Miao MIAO_VERSION="$miao_version" "$@"
