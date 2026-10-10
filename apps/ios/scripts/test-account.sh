#!/bin/sh
set -eu
# Native compilation runs on an approved macOS build host or the macOS CI runner.
ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$1
probe_root=$(mktemp -d "${TMPDIR:-/tmp}/miao-hub-account-probe.XXXXXX")
probe_device=
cleanup() {
  if [ -n "$probe_device" ]; then
    xcrun simctl shutdown "$probe_device" >/dev/null 2>&1 || true
    xcrun simctl delete "$probe_device" >/dev/null 2>&1 || true
  fi
  rm -rf "$probe_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$probe_root/HubProbe.app"
probe_sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun --sdk iphonesimulator swiftc -emit-library -emit-module -module-name MiaoCore \
  -target arm64-apple-ios17.0-simulator -sdk "$probe_sdk" \
  "$ios_root"/MiaoCore/Sources/MiaoCore/*.swift \
  -emit-module-path "$probe_root/MiaoCore.swiftmodule" -o "$probe_root/HubProbe.app/libMiaoCore.dylib"
python3 - "$probe_root" "$ios_root/../../package.json" <<'PY'
import pathlib,plistlib,json,sys
root=pathlib.Path(sys.argv[1])
version=json.load(open(sys.argv[2]))['version']
(root/'HubProbe.app/Info.plist').write_bytes(plistlib.dumps({
 'CFBundleIdentifier':'dev.miao.hub-account-probe','CFBundleExecutable':'HubProbe',
 'CFBundleName':'HubProbe','CFBundlePackageType':'APPL','CFBundleVersion':'1',
 'CFBundleShortVersionString':version,'MinimumOSVersion':'17.0','UIDeviceFamily':[1,2],
 'CFBundleSupportedPlatforms':['iPhoneSimulator'], 'LSRequiresIPhoneOS':True
}))
# Simulator Keychain resolves this Mach-O section, rather than the code-signature entitlements.
(root/'embedded.entitlements').write_bytes(plistlib.dumps({'application-identifier':'dev.miao.hub-account-probe'}))
PY
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator -sdk "$probe_sdk" \
  -I "$probe_root" -L "$probe_root/HubProbe.app" -lMiaoCore \
  -Xlinker -rpath -Xlinker @executable_path \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker "$probe_root/embedded.entitlements" \
  "$ios_root/MiaoCore/Sources/HubAccountProbe/main.swift" -o "$probe_root/HubProbe.app/HubProbe"
cp "$fixture" "$probe_root/HubProbe.app/fixture.json"
chmod 600 "$probe_root/HubProbe.app/fixture.json"
codesign --force --sign - "$probe_root/HubProbe.app/libMiaoCore.dylib"
codesign --force --sign - "$probe_root/HubProbe.app"
probe_version=$(xcrun --sdk iphonesimulator --show-sdk-version)
probe_template=$(xcrun simctl list devices available -j | python3 -c '
import json,sys
version="-".join(sys.argv[1].split(".")[:2])
for runtime,items in json.load(sys.stdin)["devices"].items():
    if not runtime.endswith("iOS-"+version): continue
    for item in items:
        if item.get("isAvailable") and item["name"].startswith("iPhone"):
            print(item["deviceTypeIdentifier"], runtime);sys.exit(0)
sys.exit("No SDK-matching iPhone simulator")
' "$probe_version")
probe_device=$(xcrun simctl create "miao-account-test-$(uuidgen)" ${probe_template})
xcrun simctl bootstatus "$probe_device" -b
xcrun simctl install "$probe_device" "$probe_root/HubProbe.app"
# Launch acceptance and console attachment are not proof of probe completion.
# The app writes an atomic receipt only after its account assertions finish.
probe_container=$(xcrun simctl get_app_container "$probe_device" dev.miao.hub-account-probe data)
probe_receipt="$probe_container/Documents/native-account-result.json"
xcrun simctl launch "$probe_device" dev.miao.hub-account-probe >/dev/null
attempt=0
while [ "$attempt" -lt 120 ]; do
  if python3 "$ios_root/scripts/account-receipt.py" "$probe_receipt"; then
    exit 0
  else
    status=$?
    if [ "$status" -ne 2 ]; then exit "$status"; fi
  fi
  attempt=$((attempt + 1))
  sleep 1
done
python3 "$ios_root/scripts/account-receipt.py" "$probe_receipt" --timeout
