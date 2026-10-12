# iOS signing and distribution

This explains how to sign the native iPhone/iPad client under `apps/ios` with a paid Apple Developer team for a physical device, and how to produce an archive for upload. Signing material (certificate private keys, provisioning profiles, API keys) **does not enter the repository**.

## Fixed identifiers

| Item | Value |
| --- | --- |
| Team (Team ID) | `<TEAM_ID>` |
| App identifier (bundle id) | `dev.miao.remote` |
| Test target | `dev.miao.remote.uitests` |
| App ID record | `<APP_ID>` |
| Capability | Push Notifications (enabled) |
| Profile file name | the provisioning profile UUID |

The `aps-environment` in `Miao.entitlements` comes from the build setting `MIAO_PUSH_ENTITLEMENT`, which `build-app.sh` maps from `MIAO_PUSH_ENVIRONMENT`: `sandbox`/`development` → `development`, `production` → `production`, anything else (the default `disabled`) → empty. An unsigned CI build therefore carries no `aps-environment`.

## Team credentials stay out of the repository

The project carries no `DEVELOPMENT_TEAM` by default. Supply it through the environment or an argument when generating a signing project:

```sh
MIAO_DEVELOPMENT_TEAM=<TEAM_ID> python3 apps/ios/scripts/create-project.py
```

That writes `DEVELOPMENT_TEAM = "<TEAM_ID>";` into the app and test targets. What is checked in is the **team-free** version; regenerate after adding source files.

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
  MIAO_DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_STYLE=Manual \
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
  MIAO_DEVELOPMENT_TEAM=<TEAM_ID> MIAO_PUSH_ENVIRONMENT=production \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=<Apple Distribution certificate SHA-1> \
  PROVISIONING_PROFILE_SPECIFIER=<App Store profile UUID> \
  -archivePath build/Miao.xcarchive

sh apps/ios/scripts/build-app.sh -exportArchive \
  -archivePath build/Miao.xcarchive -exportPath build/export \
  -exportOptionsPlist <ExportOptions.plist>

xcrun altool --upload-app -f build/export/Miao.ipa -t ios \
  --apiKey <Key ID> --apiIssuer <Issuer ID>
```

`ExportOptions.plist` needs at least `method: app-store-connect` (new Xcode) or `app-store`, and `teamID: <TEAM_ID>`. Create the App record in App Store Connect before uploading.

## TestFlight submission and external testing

After upload the build appears under App Store Connect → your app → TestFlight → builds. Distribution has two paths:

- **Internal testing** (team members, up to 100): add the build to the internal group; no review. Internal testers must be App Store Connect users and sign into TestFlight with that user's Apple ID.
- **External testing** (invited by email, up to 10,000): create an external group, add the build and invite testers. **The first build must pass Beta App Review** (later builds of the same version may not), after which testers get an email and install.

Before submitting externally, the Test Information (TestFlight → Other → Test Information, or the build page → Test Information) must be complete, or submission fails with a generic `422 MISSING_REQUIRED_DATA`. Check each item:

- **Beta App Description** — one per localization.
- **Feedback Email** — required and the easiest to miss; without it the submit fails.
- **Contact Information** — first name, last name, phone (**with country code**, e.g. `+86…`, or it fails `INVALID_PHONE_NUMBER`), email.
- **What to Test** — one per build and localization.
- **Beta License Agreement** text.
- **Export compliance** — `usesNonExemptEncryption`.
- **Demo account** — fill it if sign-in is required, otherwise mark "no sign-in required".

Notes:

- Setting `ITSAppUsesNonExemptEncryption=false` in `Info.plist` stops later builds from prompting for export compliance individually.
- The app-level `appInfos` (category and so on) may return 403 even for Admin and can only be set in the web UI; on a 422, check the Test Information page first — the UI names the missing field.
- Every one of these fields can be set through the App Store Connect API: `betaAppLocalizations` (description, feedback email, URLs), `betaBuildLocalizations` (What to Test), `betaAppReviewDetails` (contact), `betaLicenseAgreements`, `betaGroups`/`betaTesters`, and finally `betaAppReviewSubmissions` to submit.

## CI

`.github/workflows/ios-core.yml` currently only does unsigned builds and simulator tests. Wiring up a device/TestFlight build needs signing secrets in the repository (certificate `.p12`, profile, App Store Connect API key), then injecting `CODE_SIGN_IDENTITY` and `PROVISIONING_PROFILE_SPECIFIER` in the archive step; per this repository's convention these materials never go into source.
