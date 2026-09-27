# 把 miao-native 接入生产的风险清单

**语言 / Language:** [中文](rust-integration-risks.zh.md) | [English](rust-integration-risks.en.md)

本文只谈“把 `crates/miao-native` 和 `miao-run` 真正接进 `packages/miao` 生产路径”会踩的坑。收益见 [miao vs opencode](miao-vs-opencode.zh.md)，这里说风险。

## 一、阻断项（不解决就没法接）

### R1. 打包与分发（当前平台已解决 / 跨平台待办）（高）
- 证据：`packages/miao/script/build.ts` 用 `bun build --compile` 产出**单文件**二进制，原生依赖（`@ff-labs/fff-bun` 等）从 node_modules 内嵌。
- 现状：已新增 `packages/native`（`@miao/native`），用**字面量** `require("./miao-native.node")` 加载 addon，可被 `--compile` 内嵌（已实测：编译后的二进制输出 `addon: loaded`）。`packages/miao` 经 `@miao/native` 静态引用，缺失时回退 TS。
- 剩余：多平台 release 需要**按 target 构建对应的 addon**（`--single`、当前平台已可用；`packages/miao/script/build.ts` 已会为宿主构建 addon，并对非宿主 target 自动隐藏以免内嵌错平台产物）。`miao-run` 已支持从 `MIAO_RUN` 或可执行文件同目录发现（`resolveMiaoRun()`），缺失时沙箱不可用并回退；正式发布需把它随二进制一起分发。
- 缓解：release 流水线对每个 target 先跑 `packages/native/build.ts` 再打包。

### R2. CI 现在是假绿（高）
- 证据：`packages/miao/test/tool/edit-native.test.ts` 里 `withNative = native ? describe : describe.skip`、`withMiaoRun` 同理，`.node`/`miao-run` 不存在就整体 skip。
- 后果：不构建 Rust 的 CI 会“通过”，但实际一个 native 用例都没跑。任何 Rust 回归都没人发现。
- 缓解：接入前把“构建 Rust + 跑 parity 且**不允许 skip**”加进 CI，作为硬门槛。

### R3. 同步调用阻塞事件循环（高）
- 证据：`core/git.ts` / `snapshot` 的 git 都是 `ChildProcess`（异步 Effect）；而我们的 `gitStatus` 是**同步 napi 调用**。JS 单线程，同步调用期间 TUI 渲染、其它 session 的 fiber、SSE 都停。
- 量级：小仓 1ms 无感，大仓 5.6ms，超大仓（chromium 级）可能几十~几百 ms，会明显卡 UI/并发。
- 缓解：git 类调用必须走 napi async task / worker，或继续用 sidecar 进程；不能直接在 Effect 里同步调。

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
- 结论：`gitStatus` 只替换了列表这一步（约 13ms→1–5ms），**整个 snapshot 步的端到端收益有限**，除非把 add/write-tree 也用 gix 实现（复杂，gix 的 index 写回支持有限）。

### R8. gix 生命周期与资源（中）
- 每次调用 `gix::open`（5.6ms 里含 open）。缓存 `Repository` 会牵出 mmap 的 pack、fd、线程池，多 workspace/session 并发下有 fd/内存泄漏与线程安全问题。
- Windows 上的 feature（必须开 sha1）与路径处理未验证。

## 四、沙箱

### R9. 平台与废弃（高）
- 仅 macOS，且 `sandbox-exec` 已被 Apple 标记废弃，未来 macOS 可能移除；Linux（landlock/seccomp）/Windows 没后端 → **行为不一致**。

### R10. 误杀正常流程（高）
- 默认禁网会直接打断 `npm install`、`git fetch`、以及子命令里的模型调用；deny-by-default 会拦工具链/缓存的写入。
- escalation 依赖解析 stderr 的 `Operation not permitted`：程序内部 syscall 被拒时**可能不带路径或静默**，会漏判 → 用户看到“莫名其妙失败”。

### R11. 语义变化与产品决策（中）
- 把 bash 整体套沙箱，会和现有规则式权限**叠加**，出现“已批准但又被内核拒”的双重体验；默认开还是 opt-in 是产品决策，不是技术细节。

## 五、工程与供应链

### R12. 依赖与体积（中）
- `gix` 依赖树约 130 个 crate，构建时间、审计面、二进制体积都上升（现在已是 110MB 的单文件）。

### R13. 双实现维护成本（中）
- TS 与 native 两套实现并存 + feature flag，接口一改要同步两边、测试矩阵翻倍。回退路径也必须长期可用。

### R14. 可观测性（低-中）
- native 报错缺少 JS 栈；日志/telemetry 需要补，否则线上问题难定位。

## 六、建议的接入顺序与门槛

1. **先解决 R1/R2**：平台子包 + CI 强制 parity（不允许 skip）。否则不要接。
2. **先接风险最低的**：`edit` 匹配、`apply_patch`（纯函数、同步、结果可完全对比、已有 parity），并保留 feature flag 回退。
3. **git 后置**：先做 async/worker 封装（R3），并补 snapshot **全链路**（含 add/write-tree）基准；只在能覆盖大头时才接。
4. **sandbox 作为可选能力**：opt-in、带明确回退，先补 Linux 后端，再谈默认开启；不要用 stderr 解析做 escalation 的唯一依据。
5. 每一步都以“现有测试全绿 + 新 parity 不 skip + 内存/RSS 基线”作为验收。

## 结论

真正的阻断项是 **R1 打包分发** 和 **R2 CI 假绿**，其次是 **R3 同步阻塞**；沙箱的 **R9/R10** 决定了它短期内只能 opt-in。纯函数部分（edit/apply_patch）风险可控、可先接；git 与沙箱属于“能力和工程成本更高”的部分，收益要按全链路重新测。
