#!/bin/sh
set -eu
# Run on an approved macOS build host. Signing configuration stays outside this repository.
ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$ios_root/../.." && pwd)
miao_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo_root/package.json")
# Signing stays private: pass the Apple team and, only for a signing build, the
# push environment. Defaults (empty team, disabled push) keep an unsigned build
# from needing either.
miao_team=${MIAO_DEVELOPMENT_TEAM:-}
miao_push=${MIAO_PUSH_ENVIRONMENT:-}
miao_push_entitlement=
case "$miao_push" in
  sandbox|development) miao_push_entitlement=development ;;
  production) miao_push_entitlement=production ;;
esac
exec xcodebuild -project "$ios_root/Miao.xcodeproj" -scheme Miao \
  MIAO_VERSION="$miao_version" \
  MIAO_PUSH_ENTITLEMENT="$miao_push_entitlement" \
  ${miao_team:+DEVELOPMENT_TEAM="$miao_team"} \
  "$@"
