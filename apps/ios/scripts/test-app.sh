#!/bin/sh
set -eu
# UI tests run on an approved macOS build host, using its available simulators.
case "${1:-iphone}" in
  iphone|ipad) miao_test_family=${1:-iphone} ;;
  *) echo 'Usage: test-app.sh [iphone|ipad] [xcodebuild options]' >&2; exit 2 ;;
esac
if [ "$#" -gt 0 ]; then shift; fi
miao_test_device=$(xcrun simctl list devices available -j | python3 -c '
import json,sys
family=sys.argv[1]
devices=json.load(sys.stdin)["devices"]
prefix="iPhone" if family == "iphone" else "iPad"
for runtime,items in sorted(devices.items(),reverse=True):
    if "iOS" not in runtime: continue
    for item in items:
        if item.get("isAvailable") and item["name"].startswith(prefix):
            print(item["udid"]); sys.exit(0)
sys.exit("No available iOS simulator for requested family")
' "$miao_test_family")
case "${MIAO_UI_TEST_ACTION:-test}" in
  test|build-for-testing|test-without-building) miao_test_action=${MIAO_UI_TEST_ACTION:-test} ;;
  *) echo 'Invalid UI test action' >&2; exit 2 ;;
esac
exec sh "$(dirname -- "$0")/build-app.sh" "$miao_test_action" -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$miao_test_device" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- "$@"
