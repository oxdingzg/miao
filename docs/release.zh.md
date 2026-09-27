# miao 版本管理与发布

**语言 / Language:** [中文](release.zh.md) | [English](release.en.md)

## 版本方案

- miao 使用**独立版本**，从 `0.0.1` 起，遵循 semver，Git tag 为 `vX.Y.Z`。
- **权威来源**是 `oxdingzg/miao` 的最新 GitHub release tag；下一个版本 = 该 tag 按 bump（patch/minor/major）递增（`packages/script/src/index.ts`）。
- **开发/预览构建**版本形如 `0.0.1-<channel>-<timestamp>`（channel 为分支名），**永不发布**；这类构建 `Installation.isPreview()` 为 true，会跳过自更新检查。
- **正式构建** channel 为 `latest`，版本即 release tag；构建时通过 `MIAO_VERSION` 嵌入二进制，`miao --version` 显示的即是它。
- `packages/*/package.json` 里的 `version` 只是仓库内占位（当前 `0.0.1`）。发布前可以用 `bun script/set-version.ts <version>` 同步全部包，再 `bun install --lockfile-only` 更新锁文件（推荐，但不是产物必需——产物版本以 release tag 为准）。

## 发布流程

1. **确认 main 是绿的**：`bun typecheck`、对应包的 `bun test`，以及原生 CI `.github/workflows/native.yml`。
2. **触发发布**：`./script/release patch`（或 `minor` / `major`），等价于 `gh workflow run release.yml -f bump=patch`；也可在 Actions 页面手动 dispatch 并填入版本。
3. **工作流 `.github/workflows/release.yml`**：
   - `version`：运行 `script/version.ts`，按最新 release tag bump，创建**草稿** release `vX.Y.Z`，输出 `version/release/tag/repo`。
   - `cli`：矩阵 `macos-14`(arm64) / `macos-13`(x64) / `ubuntu-latest`(x64) / `ubuntu-24.04-arm`(arm64) / `windows-2025`(x64)。每个平台先 `bun install` + 安装 Rust，然后 `packages/miao/script/build.ts --single` 构建本平台二进制（会先构建本机原生 addon 并内嵌），最后把 `miao-<target>.zip|tar.gz` 上传到该草稿 release。
   - `publish`：所有平台成功后执行 `gh release edit --draft=false`，正式发布。
4. **产物**：`miao-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}.{zip,tar.gz}`，命名与 `install` 脚本、自更新（`Installation.latest` → `oxdingzg/miao/releases/latest`）一致。

## 发布前检查清单

- [ ] Windows 真机验证 VT：PowerShell 5.1 老控制台 / Windows Terminal / pwsh 7 各跑一次（目前只在 macOS 上验证了逻辑，未上真机）。
- [ ] `curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash` 能装到该 release。
- [ ] `miao upgrade` 与启动自更新检查指向 `oxdingzg/miao` 且能识别新版本。
- [ ] 原生路径默认关闭（未设 `MIAO_NATIVE` → 纯 TS），release 不受 native PoC 的未决风险影响。
- [ ] 无凭证/密钥入库；产物里不含 `auth.json`、`.env`。
- [ ] LICENSE 与归属（基于 opencode，MIT）。
- [ ] 三处版本一致：git tag、GitHub release、二进制 `miao --version`。

## 回滚

- 删除并重做：`gh release delete vX.Y.Z`，重新 dispatch。
- 本机回滚到上一版本：`ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao`。

## 已知限制

- 只产 gnu linux + 主流 mac/win；musl / baseline / windows-arm64 暂不产出。
- 原生 addon **不做交叉编译**：每个平台由对应 runner 本机构建。
- 发布属于生产动作：按本仓库规则，需**明确确认**后再执行。
