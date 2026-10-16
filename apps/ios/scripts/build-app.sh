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
# The APNs entitlement and the environment the App reports to the Hub are named
# differently: an App Store build is entitled "production", a sandbox build is
# entitled "development" while the App itself calls that environment "sandbox".
miao_push_entitlement=
miao_push_environment=
case "$miao_push" in
  sandbox|development) miao_push_entitlement=development; miao_push_environment=sandbox ;;
  production) miao_push_entitlement=production; miao_push_environment=production ;;
esac
exec xcodebuild -project "$ios_root/Miao.xcodeproj" -scheme Miao \
  MIAO_VERSION="$miao_version" \
  MIAO_PUSH_ENTITLEMENT="$miao_push_entitlement" \
  ${miao_push_environment:+MIAO_PUSH_ENVIRONMENT="$miao_push_environment"} \
  ${miao_team:+DEVELOPMENT_TEAM="$miao_team"} \
  "$@"
