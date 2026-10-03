# miao 版本管理与发布

**语言 / Language:** [中文](release.zh.md) | [English](release.en.md)

## 版本方案

- miao 使用**独立版本**，从 `0.0.1` 起，遵循 semver，Git tag 为 `vX.Y.Z`。
- **唯一权威来源是根 `package.json` 的 `version`**。`bun script/set-version.ts X.Y.Z` 更新它并同步所有 workspace 的 `package.json`；不带参数运行则只做同步。构建与源码运行都读取这个版本，`MIAO_VERSION` 只能断言同一个值，不支持自动 bump 或时间戳版本。
- **channel 决定是否为正式构建**：发布构建的 channel 为 `latest`；其它构建（`miao-dev` 的 `local`、`miao-preview` 的分支名）是预览构建，`Installation.isPreview()` 为 true，不做自更新检查，也使用独立的数据库文件。
- 正式构建使用 `miao.db`，预览构建使用 `miao-<channel>.db`。
- `CHANGELOG.md` 和 GitHub release 记录发布历史，不是当前开发版本的来源。

## 发布流程

1. **确认 main 是绿的**：`bun typecheck`、对应包的 `bun test`，以及原生 CI `.github/workflows/native.yml`。发布前用 `./script/install-local.sh` 构建并冒烟测试 `miao-preview`。
2. **触发发布**：在干净的 main 上运行 `./script/release X.Y.Z`。脚本依次执行 `bun script/set-version.ts X.Y.Z`、提交 `chore: release X.Y.Z`、push，然后 `gh workflow run release.yml --ref main`。工作流**没有输入参数**，版本完全取自根 `package.json`；在 Actions 页面手动 dispatch 也一样。
3. **工作流 `.github/workflows/release.yml`**：
   - `version`：运行 `script/version.ts`，以根 `package.json` 的版本创建**草稿** release `vX.Y.Z`，并生成 release notes，输出 `version/release/tag/repo`。
   - `cli`：矩阵 `macos-26`(darwin-arm64) / `macos-26-intel`(darwin-x64) / `ubuntu-latest`(linux-x64) / `ubuntu-24.04-arm`(linux-arm64) / `windows-2025`(windows-x64)。每个平台先 `bun install` + 安装 Rust，然后 `packages/miao/script/build.ts --single` 构建本平台二进制（会先构建本机原生 addon 并内嵌），最后把 `miao-<target>.zip|tar.gz` 上传到该草稿 release。
   - `publish`：所有平台成功后，先把 Windows 签名状态追加到 release 说明，再执行 `gh release edit --draft=false` 正式发布。
4. **产物**：`miao-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}.{zip,tar.gz}`，命名与 `install` 脚本、自更新（`Installation.latest` → `oxdingzg/miao/releases/latest`）一致。

上述工作流是当前维护的发布入口。每次构建通过 `packages/miao/script/generate.ts` 从 `https://models.dev/api.json` 读取模型目录，也可以用 `MODELS_DEV_API_JSON` 指定本地文件。仓库没有单独提交模型快照的工作流；运行时会独立刷新缓存中的模型目录。

已于 2026-10-03 向 [SignPath Foundation](https://signpath.org) 提交 Windows 代码签名申请。目前等待审核及 CI 签名接入，现有 Windows 二进制尚未签名。`publish` 步骤会在下载页面记录当前状态。审核通过并接入签名后，更新状态并使用署名：Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org)。

## 变更日志

- 仓库根 `CHANGELOG.md` 是**可直接查看的版本历史**（Keep a Changelog 格式），每次发布新增一节。
- GitHub release 的 notes 由 `script/changelog.ts` 从 Conventional Commits **确定性生成**（不再依赖 LLM / `opencode` CLI）：`feat → Added`、`fix`/`revert → Fixed`、`perf → Performance`、`refactor → Changed`，跳过 `chore`/`ci`/`test`/`docs`/`style`/`build`。
- 预览与写入：
  - 预览某版本区间：`bun script/changelog.ts --from <上一版本> --to HEAD --version <x.y.z> --print`
  - 写入 `CHANGELOG.md`：追加 `--write`
  - 发布时 `script/version.ts` 以 `--to <sha>` 调用它生成 `UPCOMING_CHANGELOG.md`，即 release notes。

## 发布前检查清单

- [ ] Windows 真机验证 VT：PowerShell 5.1 老控制台 / Windows Terminal / pwsh 7 各跑一次（目前只在 macOS 上验证了逻辑，未上真机）。
- [ ] `curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash` 能装到该 release。
- [ ] `miao upgrade` 与启动自更新检查指向 `oxdingzg/miao` 且能识别新版本。
- [ ] native addon：确认各平台构建的 addon 能加载、且 `MIAO_NATIVE=0` 可回退，OS 沙箱 runner 与其他原生辅助不受 native PoC 的未决风险影响。
- [ ] 无凭证/密钥入库；产物里不含 `auth.json`、`.env`。
- [ ] LICENSE 与归属（基于 opencode，MIT）。
- [ ] 三处版本一致：git tag、GitHub release、二进制 `miao --version`。

## 回滚

- 删除并重做：`gh release delete vX.Y.Z`，重新 dispatch。
- 本机回滚到上一 preview 构建：`ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`。

## 已知限制

- 只产 gnu linux + 主流 mac/win；musl / baseline / windows-arm64 暂不产出。
- 原生 addon **不做交叉编译**：每个平台由对应 runner 本机构建。
- 发布属于生产动作：按本仓库规则，需**明确确认**后再执行。
