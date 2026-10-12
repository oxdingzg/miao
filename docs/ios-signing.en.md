# iOS signing and distribution

This explains how to sign the native iPhone/iPad client under `apps/ios` with a paid Apple Developer team for a physical device, and how to produce an archive for upload. Signing material (certificate private keys, provisioning profiles, API keys) **does not enter the repository**.

## Fixed identifiers

| Item | Value |
| --- | --- |
| Team (Team ID) | `9LJ9A465L9` |
| App identifier (bundle id) | `dev.miao.remote` |
| Test target | `dev.miao.remote.uitests` |
| App ID record | `FMAUTSH25S` |
| Capability | Push Notifications (enabled) |
| Profile file name | the provisioning profile UUID |

The `aps-environment` in `Miao.entitlements` comes from the build setting `MIAO_PUSH_ENTITLEMENT`, which `build-app.sh` maps from `MIAO_PUSH_ENVIRONMENT`: `sandbox`/`development` → `development`, `production` → `production`, anything else (the default `disabled`) → empty. An unsigned CI build therefore carries no `aps-environment`.

## Team credentials stay out of the repository

The project carries no `DEVELOPMENT_TEAM` by default. Supply it through the environment or an argument when generating a signing project:

```sh
MIAO_DEVELOPMENT_TEAM=9LJ9A465L9 python3 apps/ios/scripts/create-project.py
```

That writes `DEVELOPMENT_TEAM = "9LJ9A465L9";` into the app and test targets. What is checked in is the **team-free** version; regenerate after adding source files.

## Managing certificates with the App Store Connect API

Every certificate and profile for the paid team can be created through the App Store Connect API with one App Store Connect API key (Admin role), without clicking through the site.

- Create the key: App Store Connect → Users and Access → Integrations → App Store Connect API → `+`. Note the **Issuer ID** and **Key ID**, and download the `.p8` (once only).
- Store the key at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` (directory `700`, file `600`).
- Sign a JWT with ES256 in Python, then call `https://api.appstoreconnect.apple.com/v1/...`.

Common calls:

- Register an App ID: `POST /v1/bundleIds` with `identifier: dev.miao.remote`, `platform: IOS`.
- Enable a capability: `POST /v1/bundleIdCapabilities` with `capabilityType: PUSH_NOTIFICATIONS`.
- Create a certificate: generate an RSA private key + CSR locally, `POST /v1/certificates` with `certificateType: DISTRIBUTION` or `DEVELOPMENT` and the CSR as `csrContent`.
- Create a profile: `POST /v1/profiles` with `profileType: IOS_APP_STORE` (distribution) or `IOS_APP_DEVELOPMENT` (device, bound to a registered device).
- Register a device: `POST /v1/devices` with the device `udid`.

### Installing an API-created certificate locally

- Import the private key and certificate into the login keychain:
  `security import <key.pem> -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign`
- A provisioning profile must be named by its **UUID** and its content must be **DER binary** (not base64):
  ```sh
  python3 -c 'import base64,re,sys; s=re.sub(r"[^A-Za-z0-9+/=]","",open(sys.argv[1]).read()); open(sys.argv[2],"wb").write(base64.b64decode(s))' in.b64 out.der
  cp out.der ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<UUID>.mobileprovision
  sudo mkdir -p /Library/MobileDevice/Provisioning\ Profiles
  sudo cp out.der /Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision
  ```
  Note: the API returns the CMS bytes base64-encoded, while `security cms -D` and the Xcode command line only read DER; dropping the base64 straight into the directory causes “No profile matching … found”.

## Device build and install

```sh
sh apps/ios/scripts/build-app.sh build -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  MIAO_DEVELOPMENT_TEAM=9LJ9A465L9 CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=<Apple Development certificate SHA-1> \
  PROVISIONING_PROFILE_SPECIFIER=<development profile UUID>

APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/Miao-*/Build/Products/Debug-iphoneos/Miao.app)
xcrun devicectl device install app --device <device UDID> "$APP"
xcrun devicectl device process launch --device <device UDID> dev.miao.remote
```

Notes:

- If the device already has an app of the same name signed by another team, the install is rejected with `MismatchedApplicationIdentifierEntitlement`. Uninstall the old one first:
  `xcrun devicectl device uninstall app --device <UDID> dev.miao.remote`.
- The simulator-only UI smoke test uses `test-app.sh`, which signs ad-hoc and needs no paid team.
- Compilation is heavy work; per the repository rules it should run off-machine.

## TestFlight archive

```sh
sh apps/ios/scripts/build-app.sh archive -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  MIAO_DEVELOPMENT_TEAM=9LJ9A465L9 MIAO_PUSH_ENVIRONMENT=production \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=<Apple Distribution certificate SHA-1> \
  PROVISIONING_PROFILE_SPECIFIER=<App Store profile UUID> \
  -archivePath build/Miao.xcarchive

sh apps/ios/scripts/build-app.sh -exportArchive \
  -archivePath build/Miao.xcarchive -exportPath build/export \
  -exportOptionsPlist <ExportOptions.plist>

xcrun altool --upload-app -f build/export/Miao.ipa -t ios \
  --apiKey <Key ID> --apiIssuer <Issuer ID>
```

`ExportOptions.plist` needs at least `method: app-store-connect` (new Xcode) or `app-store`, and `teamID: 9LJ9A465L9`. Create the App record in App Store Connect before uploading.

## CI

`.github/workflows/ios-core.yml` currently only does unsigned builds and simulator tests. Wiring up a device/TestFlight build needs signing secrets in the repository (certificate `.p12`, profile, App Store Connect API key), then injecting `CODE_SIGN_IDENTITY` and `PROVISIONING_PROFILE_SPECIFIER` in the archive step; per this repository's convention these materials never go into source.
