#!/bin/sh
set -eu
# UI tests run on an approved macOS build host, using its available simulators.
case "${1:-iphone}" in
  iphone|ipad) miao_test_family=${1:-iphone} ;;
  *) echo 'Usage: test-app.sh [iphone|ipad] [xcodebuild options]' >&2; exit 2 ;;
esac
if [ "$#" -gt 0 ]; then shift; fi
miao_test_sdk=$(xcrun --sdk iphonesimulator --show-sdk-version)
miao_test_template=$(xcrun simctl list devices available -j | python3 -c '
import json,sys
family,sdk=sys.argv[1:]
prefix="iPhone" if family == "iphone" else "iPad"
version="-".join(sdk.split(".")[:2])
for runtime,items in json.load(sys.stdin)["devices"].items():
    if not runtime.endswith("iOS-"+version): continue
    for item in items:
        if item.get("isAvailable") and item["name"].startswith(prefix):
            print(item["deviceTypeIdentifier"], runtime); sys.exit(0)
sys.exit("No SDK-matching iOS simulator for requested family")
' "$miao_test_family" "$miao_test_sdk")
# Own this simulator exclusively; never shut down another session's devices.
miao_test_device=$(xcrun simctl create "miao-ui-test-$(uuidgen)" ${miao_test_template})
miao_test_process=
cleanup() {
  xcrun simctl shutdown "$miao_test_device" >/dev/null 2>&1 || true
  xcrun simctl delete "$miao_test_device" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'if [ -n "$miao_test_process" ]; then kill "$miao_test_process" 2>/dev/null || true; fi; exit 130' INT
trap 'if [ -n "$miao_test_process" ]; then kill "$miao_test_process" 2>/dev/null || true; fi; exit 143' TERM
case "${MIAO_UI_TEST_ACTION:-test}" in
  test|build-for-testing|test-without-building) miao_test_action=${MIAO_UI_TEST_ACTION:-test} ;;
  *) echo 'Invalid UI test action' >&2; exit 2 ;;
esac
if [ "$miao_test_action" != build-for-testing ]; then
  xcrun simctl boot "$miao_test_device"
  xcrun simctl bootstatus "$miao_test_device" -b
fi
sh "$(dirname -- "$0")/build-app.sh" "$miao_test_action" -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$miao_test_device" \
  -parallel-testing-enabled NO \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- "$@" &
miao_test_process=$!
miao_test_result=0
wait "$miao_test_process" || miao_test_result=$?
miao_test_process=
exit "$miao_test_result"
