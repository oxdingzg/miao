# 把 miao-native 接入生产的风险清单

**语言 / Language:** [中文](rust-integration-risks.zh.md) | [English](rust-integration-risks.en.md)

本文只谈“把 `crates/miao-native` 和 `miao-run` 真正接进 `packages/miao` 生产路径”会踩的坑。收益见 [native component benchmarks](native-benchmarks.zh.md)，这里说风险。

## 一、阻断项（不解决就没法接）

### R1. 打包与分发（已解决）（高）
- 证据：`packages/miao/script/build.ts` 用 `bun build --compile` 产出**单文件**二进制，原生依赖（`@ff-labs/fff-bun` 等）从 node_modules 内嵌。
- addon：新增 `packages/native`（`@miao/native`），用**字面量** `require("./miao-native.node")` 加载 addon，可被 `--compile` 内嵌（已实测）。release 用 `--single`，每个平台 runner 先跑 `packages/native/build.ts` 构建**宿主** addon，非宿主 target 自动隐藏，避免把错平台 `.node` 打进包。
- 沙箱 sidecar：不再需要随包分发独立的 `miao-run`。沙箱逻辑抽到 `crates/miao-sandbox`，由 addon 暴露 `sandboxProfile`（macOS profile）与 `sandboxRestrict`（Linux landlock）；编译后的主二进制通过隐藏命令 `__sandbox-run` **自执行**运行沙箱子进程（`build.ts` 定义 `MIAO_PACKAGED`，`SandboxRunner.resolve()` 据此返回 `process.execPath` + `__sandbox-run`）。单文件、每平台天然对应、复用同一签名/公证。`miao-run` 仅保留给 dev/测试与 `MIAO_RUN` 覆盖。
- 已实测：`miao-preview __sandbox-run --print-profile`、workdir 内写入成功、workdir 外写入被拒并写出 deny-report。

### R2. CI 现在是假绿（高）
- 证据：撰写时 `packages/miao/test/tool/*-native.test.ts` 里用 `withNative = native ? describe : describe.skip`（`withMiaoRun` 同理），`.node`/`miao-run` 不存在就整体 skip。这些测试已随 V1 工具删除；当前原生覆盖是 Rust 单元测试加 `packages/core/test/sandbox-policy.test.ts`、`packages/core/test/tool-bash-sandbox.test.ts`。
- 后果：不构建 Rust 的 CI 会“通过”，但实际一个 native 用例都没跑。任何 Rust 回归都没人发现。
- 缓解：`.github/workflows/native.yml` 的 `native` 与 `sandbox-linux` job 会构建 Rust 并跑沙箱测试，作为硬门槛。

### R3. 同步调用阻塞事件循环（高）
- 证据：`core/git.ts` / `snapshot` 的 git 都是 `ChildProcess`（异步 Effect）；而我们的 `gitStatus` 是**同步 napi 调用**。JS 单线程，同步调用期间 TUI 渲染、其它 session 的 fiber、SSE 都停。
- 量级：小仓 1ms 无感，大仓 5.6ms，超大仓（chromium 级）可能几十~几百 ms，会明显卡 UI/并发。
- 缓解：git 类调用必须走 napi async task / worker。已实现 `gitStatusAsync`（napi `AsyncTask`，跑在 libuv 线程池），同步版 `gitStatus` 只保留给测试/基准。

## 二、正确性

### R4. JS 与 Rust 的字符串语义差异（中-高）
现有 parity 以 ASCII 为主，以下差异会产生**结果不一致**而不是报错：
- 长度：JS `.length` 是 UTF-16 码元，Rust `chars()`/bytes 不同 → `is_disproportionate_match`、相似度阈值在 emoji/astral 字符上会分叉。
- `trim()` 的空白集合不同（JS 含 `\uFEFF` 等，Rust `char::is_whitespace` 不含）→ 影响 LineTrimmed/BlockAnchor。
- 正则：`normalize_whitespace` 用 `\s+`，Rust regex 与 JS 的 `\s` 覆盖码点不完全一致。
- 缓解：补 emoji/CJK/混合换行的 parity 语料；对差异点显式对齐或文档化“不保证”范围。

### R5. panic 会带崩进程（中-高）
- 证据：napi-rs 自己的注释就写明 panic 可能 `abort` 进程。我们的代码里仍有 `unwrap`、索引取值等路径。
- 缓解：napi 边界包 `catch_unwind`，内部全面去 `unwrap`/越界，加 fuzz 输入。

### R6. 错误语义与 Effect 集成（中）
- TS 侧 `core/tool/edit.ts` 对 `FileMutation.StaleContentError` 有专门的 `ToolFailure` 映射，`apply_patch` 抛的 `Error` 有固定文案。native 抛的是 napi `Error`，文案虽对齐，但**类型丢失**（不再是特定 Error 类）；需要重新写映射，并保证 Effect 中断/缺陷语义不被破坏。
- `deriveNewContents` 的 `unified_diff` 现在是 simplified diff；生产其实只用 `content`/`bom`。接的时候别顺手把它换成 `similar` 的统一 diff，否则静默改变行为。

## 三、范围与收益被高估

### R7. git 收益被高估（中）
- 证据：`snapshot` 热路径是 `diff-files`+`ls-files`（我们对比的 2 个调用）**之后还有** `git add --all`（`snapshot/index.ts:149`）和 `write-tree`（:341），这两个仍是子进程，且在大仓上是大头。
- 结论：`gitStatus` 只替换了列表这一步，**整个 snapshot 步的端到端收益有限**，除非把 add/write-tree 也用 gix 实现（复杂，gix 的 index 写回支持有限）。
- 实测（3300 文件 / 600 变更）：listing 18.2 ms → native `gitStatus` 9.4 ms；`git add --all` 6.4 ms；`write-tree` 8.3 ms。整步约 32.9 ms → 24.0 ms（约 27%），add/write-tree 仍占约 44%。
- 追加（本次接入）：`Git.status.entries` 已改用 `gitStatusAsync`，并补齐 untracked 与逐条增删行数；`add`/`write-tree` 仍是子进程，上述 R7 结论不变。

### R8. gix 生命周期与资源（中）
- 每次调用 `gix::open`（5.6ms 里含 open）。缓存 `Repository` 会牵出 mmap 的 pack、fd、线程池，多 workspace/session 并发下有 fd/内存泄漏与线程安全问题。
- Windows 上的 feature（必须开 sha1）与路径处理未验证。

## 四、沙箱

### R9. 平台与废弃（高）
- 现有后端：macOS seatbelt（`sandbox-exec`）+ Linux landlock（TCP 禁网，ABI v4 BestEffort）；Windows 仍无后端 → **跨平台行为不一致**，且 `sandbox-exec` 已被 Apple 标记废弃、未来 macOS 可能移除。
- 缓解：Windows 后端（AppContainer + Job object）规格见 [windows-sandbox](windows-sandbox.zh.md)，待实现；`SandboxRunner.available()` 在无后端的平台返回 false，调用方回退。

### R10. 误杀正常流程（高）
- 默认禁网会直接打断 `npm install`、`git fetch`、以及子命令里的模型调用；deny-by-default 会拦工具链/缓存的写入。
- escalation 依赖解析 stderr：macOS seatbelt 报 `Operation not permitted`，Linux landlock 报 `Permission denied`（已实测），且 shell 前缀不一（`sh: /path: …` vs `sh: 1: cannot create /path: …`）。解析器现同时匹配两种字样并从首个 `/` 取路径，但仍是启发式：无 `/` 的相对路径、或程序内部静默拒绝会漏判 → 用户看到“莫名其妙失败”。不能作为唯一 escalation 依据。

### R11. 语义变化与产品决策（中）
- 已接入为 **opt-in**（`MIAO_SANDBOX=1` 或 `sandbox.mode: "workspace-write"`）：V2 `bash` 工具用当前 Location、命令工作目录、临时目录与配置的 `writable_roots` 预填沙箱可写根，尽量不出现"已批准但又被内核拒"；被内核拒的路径再走 `external_directory` 追问，批准后带该目录重跑。默认放行网络（`MIAO_SANDBOX_DENY_NETWORK=1` 才禁）。**默认开还是 opt-in 仍是产品决策**。

## 五、工程与供应链

### R12. 依赖与体积（中）
- `gix` 依赖树约 130 个 crate，构建时间、审计面、二进制体积都上升（现在已是 110MB 的单文件）。

### R13. 双实现维护成本（中）
- TS 与 native 两套实现并存 + feature flag，接口一改要同步两边、测试矩阵翻倍。回退路径也必须长期可用。

### R14. 可观测性（低-中）
- native 报错缺少 JS 栈；日志/telemetry 需要补，否则线上问题难定位。

## 六、建议的接入顺序与门槛

1. ~~先解决 R1/R2~~ → **已解决**：addon 每平台构建 + 沙箱自执行（R1）；`native`/`sandbox-linux` CI job 强制构建并运行沙箱测试（R2）。
2. ~~先接风险最低的~~ → **换了一种接法**：原计划基于「native `edit`/`apply_patch` 只被 V1 工具消费」这一假设。该假设并不成立 —— V2 工具本身就经 `packages/core/src/tool/edit-match.ts` 与 `packages/core/src/patch.ts` 调用同一套 `matchEdit` 与 `deriveNewContentsV2`，由 `MIAO_NATIVE` 控制（默认开启）。V1 移除的是工具，不是原语。
3. **git status 已接入（窄范围）**：async 封装（R3）已完成并用于 `Git.status.entries`，含 untracked 与逐条增删行数；`add`/`write-tree` 仍是子进程，snapshot 全链路收益仍有限（R7）。
4. **sandbox 作为可选能力**：已 opt-in 接入 V2 `bash` 工具（`MIAO_SANDBOX=1` 或 `sandbox.mode`）并可回退；Linux 后端已补；默认开启仍待定。不要用 stderr 解析做 escalation 的唯一依据。
5. 每一步都以“现有测试全绿 + 新 parity 不 skip + 内存/RSS 基线”作为验收。

## 结论

**R1 打包分发**（addon 每平台构建 + 沙箱自执行）与 **R2 CI 假绿** 已解决；**R3 同步阻塞**已有 async 版，接线时强制用 Async 即可。剩下的实质风险是 **R4 字符串语义**、**R5/R6 正确性**（panic/错误类型），以及沙箱的 **R9（平台不一致）/R10（误杀、stderr escalation 不可靠）**——后者决定了沙箱短期内只能 opt-in。纯函数部分（edit/apply_patch）风险可控、已先接；git status 的只读路径已按 async 接入 `MIAO_NATIVE` 并带回退，沙箱属于“能力和工程成本更高”的部分，收益要按全链路重新测。
