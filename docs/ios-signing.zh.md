# iOS 签名与分发

本文说明如何用付费的 Apple Developer 团队给 `apps/ios` 的原生 iPhone/iPad 客户端做真机签名、以及如何构建可上传的归档。签名材料（证书私钥、描述文件、API 密钥）**不进入仓库**。

## 固定标识

| 项 | 值 |
| --- | --- |
| 团队 (Team ID) | `<TEAM_ID>` |
| App 标识 (bundle id) | `dev.miao.remote` |
| 测试 target | `dev.miao.remote.uitests` |
| App ID 记录 | `<APP_ID>` |
| 能力 | Push Notifications（已开启） |
| 描述文件命名 | 按描述文件 UUID 命名 |

`Miao.entitlements` 里的 `aps-environment` 取自构建设置 `MIAO_PUSH_ENTITLEMENT`，它在 `build-app.sh` 中由 `MIAO_PUSH_ENVIRONMENT` 映射得到：`sandbox`/`development` → `development`，`production` → `production`，其余（默认 `disabled`）为空。这样未签名的 CI 构建不会带 `aps-environment`。

## 团队凭据不进仓库

工程默认不写 `DEVELOPMENT_TEAM`。生成签名工程时通过环境变量或参数传入：

```sh
MIAO_DEVELOPMENT_TEAM=<TEAM_ID> python3 apps/ios/scripts/create-project.py
```

这会把 `DEVELOPMENT_TEAM = "<TEAM_ID>";` 写进 App 与测试 target。仓库里签入的是**不带团队**的版本，改完源码后重新生成即可。

## 用 App Store Connect API 管理证书

付费团队的一切证书与描述文件都可以用一把 App Store Connect API key（角色 Admin）通过 App Store Connect API 生成，无需在网页手动点。

- 生成 key：App Store Connect → 用户和访问 → 集成 → App Store Connect API → `+`。记下 **Issuer ID** 与 **Key ID**，下载 `.p8`（只此一次）。
- 存放密钥：`~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`（目录 `700`，文件 `600`）。
- 用 Python 以 ES256 对 JWT 签名，再调用 `https://api.appstoreconnect.apple.com/v1/...`。

常用调用：

- 注册 App ID：`POST /v1/bundleIds`，`identifier: dev.miao.remote`、`platform: IOS`。
- 开启能力：`POST /v1/bundleIdCapabilities`，`capabilityType: PUSH_NOTIFICATIONS`。
- 建证书：本地生成 RSA 私钥 + CSR，`POST /v1/certificates`，`certificateType: DISTRIBUTION` 或 `DEVELOPMENT`，`csrContent` 传 CSR。
- 建描述文件：`POST /v1/profiles`，`profileType: IOS_APP_STORE`（分发）或 `IOS_APP_DEVELOPMENT`（真机，需绑定已注册设备）。
- 注册设备：`POST /v1/devices`，`udid` 取真机 UDID。

### 把 API 证书装进本机

- 导出/导入私钥与证书到登录钥匙串：
  `security import <key.pem> -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign`
- 描述文件必须按 **UUID** 命名，且内容为 **DER 二进制**（不是 base64）：
  ```sh
  curl -s ... # 或 API 的 profileContent
  # base64 解码为 DER
  python3 -c 'import base64,re,sys; s=re.sub(r"[^A-Za-z0-9+/=]","",open(sys.argv[1]).read()); open(sys.argv[2],"wb").write(base64.b64decode(s))' in.b64 out.der
  cp out.der ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<UUID>.mobileprovision
  sudo mkdir -p /Library/MobileDevice/Provisioning\ Profiles
  sudo cp out.der /Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision
  ```
  注意：API 返回的是 base64 的 CES/CMS 字节，而 `security cms -D` 与 Xcode 命令行都只认 DER；base64 直接丢进目录会导致 “No profile matching … found”。

## 真机构建与安装

```sh
sh apps/ios/scripts/build-app.sh build -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  MIAO_DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=<Apple Development 证书的 SHA-1> \
  PROVISIONING_PROFILE_SPECIFIER=<开发描述文件 UUID>

APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/Miao-*/Build/Products/Debug-iphoneos/Miao.app)
xcrun devicectl device install app --device <设备 UDID> "$APP"
xcrun devicectl device process launch --device <设备 UDID> dev.miao.remote
```

说明：

- 若设备上已有另一团队签名的同名 App，安装会被 `MismatchedApplicationIdentifierEntitlement` 拒绝。先卸载旧包：
  `xcrun devicectl device uninstall app --device <UDID> dev.miao.remote`。
- 纯模拟器的 UI 冒烟测试用自带 `test-app.sh`，它使用 ad-hoc 签名，不需要付费团队。
- 编译属于重活，按仓库规则应离机执行。

## TestFlight 归档

```sh
sh apps/ios/scripts/build-app.sh archive -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  MIAO_DEVELOPMENT_TEAM=<TEAM_ID> MIAO_PUSH_ENVIRONMENT=production \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=<Apple Distribution 证书 SHA-1> \
  PROVISIONING_PROFILE_SPECIFIER=<App Store 描述文件 UUID> \
  -archivePath build/Miao.xcarchive

sh apps/ios/scripts/build-app.sh -exportArchive \
  -archivePath build/Miao.xcarchive -exportPath build/export \
  -exportOptionsPlist <ExportOptions.plist>

xcrun altool --upload-app -f build/export/Miao.ipa -t ios \
  --apiKey <Key ID> --apiIssuer <Issuer ID>
```

`ExportOptions.plist` 至少包含 `method: app-store-connect`（新 Xcode）或 `app-store`、`teamID: <TEAM_ID>`。上传前在 App Store Connect 建好 App 记录。

## CI

`.github/workflows/ios-core.yml` 目前只做无签名构建与模拟器测试。要接入真机/TestFlight，需要向仓库添加签名 secret（证书 `.p12`、描述文件、App Store Connect API key），再在归档步骤注入 `CODE_SIGN_IDENTITY` 与 `PROVISIONING_PROFILE_SPECIFIER`；这些材料按本仓库约定不写进源码。
