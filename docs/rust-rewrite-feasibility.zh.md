# Rust 重写 miao：我的判断与实施计划

**语言 / Language:** [English](rust-rewrite-feasibility.en.md) | [中文](rust-rewrite-feasibility.zh.md)

## 背景

我一直在考虑把 miao 的一部分用 Rust 重写。动机不是“Rust 更快”这种笼统说法，而是三件很具体的事：

1. **常驻内存**：Bun 进程在长会话、大仓库下很容易涨到几百 MB。
2. **沙箱**：bash 和工具的权限目前只能靠规则约束，只有落到进程级（seccomp/landlock）才谈得上真正的隔离。
3. **单文件分发**：这条已经被 Bun 的 `--compile` 解决了，不算动机。

这份文档是我的判断和计划，不是评测报告。

## 我的结论

**整体重写不做。** 不是技术上做不到，是投入产出比不成立。

引擎（`miao + core + tui + llm + server + schema + protocol + client + plugin`）大约 17.6 万行 TS，其中七成是网络 IO 或者绑死在 JS 生态上的部分，搬到 Rust 收益接近零甚至为负。

真正值得用 Rust 的是四类边界干净、和生态无关的模块：**文本处理、进程/沙箱、搜索、Git**。我会把这四类做成一个独立的 native 库，其余继续用 TS。

## 我盘了一遍仓库

先量清楚规模，再谈语言。

| 部分 | 规模 | 处置 |
|---|---|---|
| 引擎 `miao/core/tui/llm/server/schema/protocol/client/plugin` | ~17.6 万行 | 本次考虑对象 |
| `app`(Solid/Vite)、`ui`、`console`、`stats`、`web/docs` | ~30 万行 | 前端，不动 |
| `desktop`(Electron) | 124 文件 | 不动 |
| 测试 | miao 300 + core 160 + tui 53 文件 | 保持并复用 |

引擎侧：`miao/src` 98 个运行时依赖，**528 个文件 import `effect`**，25 个 tool，26 个 CLI 命令，21 个 HttpApi group。

有一个事实改变了我的排序：**很多热点已经是原生绑定**。搜索用 `@ff-labs/fff-*`，文件监听用 `@parcel/watcher`，PTY 用 `node-pty`，图像用 `photon-node`，SQLite 用 `bun:sqlite`。所以 Rust 的增量收益只存在于“这些库覆盖不到、或者 JS 层是 CPU 密集、或者需要沙箱”的地方。别的地方换语言只是换了个写法。

## 为什么整体重写不行

**1. Effect 是骨架，不是库。** 整个引擎建在 Effect v4 beta 上：Layer/DI、Fiber、Stream、Schema、结构化并发。Rust 侧只有 tokio + serde，等于要先把这套框架重新设计一遍。这不是翻译代码，是重新架构。

**2. AI SDK 是 JS 独占的。** 19 个 `@ai-sdk/*` provider，外加 openrouter/gateway/gitlab/venice。要在 Rust 里重写流式 tool-call、reasoning 字段、图片、usage、OAuth device code，这是整个项目最重、也最容易长期落后的部分。

**3. TUI 是自己的渲染器。** `@opentui/core + @opentui/solid`，还有 shimmer 动画和插件 API。换 ratatui 会同时丢掉视觉保真度和插件兼容。

**4. 插件要跑用户 JS/TS。** Rust 宿主里仍然得内嵌 JS 运行时（deno_core/quickjs）或者保留 Node，等于没省掉。

成本上，Rust 侧大概 15–25 万行、6–18 人月才能对等，而且 provider/TUI 会一直追。我不认为这值得。

## 我决定怎么做

分三步，前两步是有条件的，第三步只是方向。

### 第一步：抽出 `miao-native`，只搬四类模块

按优先级排，理由是净收益（性能/内存 + 战略价值，减去迁移成本和生态损失）：

| 顺序 | 模块 | 目标文件 | 为什么先做 |
|---|---|---|---|
| 1 | 文本处理 diff/patch/edit/format | `core/tool/{edit,apply-patch}`、`miao/src/format`、`miao/tool/{edit,apply_patch}`、`session/revert-diff` | 纯 CPU 文本算法，生态无关，改完可被现有测试直接验证 |
| 2 | 进程/沙箱 | `core/pty`、`AppProcess`、`miao/tool/{shell,bash}` | seccomp/landlock 是 JS 做不到的，属于必须用 Rust 的能力 |
| 3 | 搜索/遍历/忽略 | `core/filesystem/*`、`core/tool/{grep,glob,read}` | ripgrep+ignore+globset 一套打通；但 fff 已原生，先测增量再决定 |
| 4 | Git/worktree/快照 | `core/git.ts`、`worktree`、`snapshot` | 大仓和高频 diff 下 `gix` 明显优于 JS 层，和 #1 同属文本密集 |

这四块的共同点：不依赖 Effect、不依赖 AI SDK、不依赖 UI，可以独立成库，也能单独测试。

### 第一步首选：改造 edit/diff 管线（当前实现 vs Rust）

四个模块里我先做这个，理由不是它最快，而是它同时满足：每次编辑都会走到、纯逻辑不碰 IO/Effect、有现成测试可做等价验证、代码量最小。

**当前实现**

- 匹配：`packages/miao/src/tool/edit.ts` 的 `replace()`，依次跑 9 个 replacer（Simple / LineTrimmed / BlockAnchor / WhitespaceNormalized / IndentationFlexible / EscapeNormalized / TrimmedBoundary / ContextAware / MultiOccurrence）。`BlockAnchor` 用全矩阵 Levenshtein 算相似度。
- 生成 diff：`diff`（jsdiff 8.0.2）的 `diffLines` 与 `createTwoFilesPatch`，在 `miao/src/tool/{edit,apply_patch}.ts`、`core/src/tool/{edit,apply-patch}.ts`、`snapshot/index.ts`、`project/vcs.ts` 里反复调用。
- 一次编辑里 `createTwoFilesPatch` 会被调用多次：格式化前后各一次，core 侧还有一次。

**实测（同一台机器，release / 优化；合成样本）**

diff 生成，200 处改动：

| 文件行数 | 当前 jsdiff | Rust `similar` | 倍率 |
|---|---|---|---|
| 12k | 16.3 / 18.6 ms | 4.5 / 3.9 ms | ~3.5–4.7x |
| 60k | 24.3 / 27.3 ms | 15.7 / 12.4 ms | ~1.5–2.2x |
| 150k | 40.1 / 48.2 ms | 33.2 / 32.8 ms | ~1.2–1.5x |

edit 匹配（12k 行文件）与 Levenshtein：

| 场景 | 当前 |
|---|---|
| 精确匹配 | 0.24 ms |
| 模糊匹配（缩进 / 空白） | 0.77–0.88 ms |
| Levenshtein 长行（1900 字符） | 36.8 ms（全矩阵）/ 12.7 ms（滚动数组） |

Rust `strsim` 同规模 Levenshtein：**3.1 ms**，相对全矩阵约 12x，相对滚动数组约 4x。

**我的结论**

- 典型小文件的 edit 匹配本来就是亚毫秒，Rust 不会带来可感知提升，这条不要指望。
- 真正的收益在两处：**大文件 diff（3–5x）**，以及**病态输入（超长行 / 压缩文件）下把 36 ms 的 Levenshtein 悬崖削平（约 12x）**。
- 还有一条不在数字里：jsdiff 每个变更都建 JS 对象和字符串，长会话里是持续的内存压力和 GC；Rust 侧是 O(N) 字节。这项对“降常驻内存”的目标贡献更稳定。

**接口**：用 napi-rs 暴露 `applyEdit(content, oldString, newString, replaceAll) -> { content, additions, deletions } | error`，以及 `diffLines / unifiedPatch(before, after) -> { patch, additions, deletions }`，保持与现有返回结构一致。原生侧只做纯函数，不碰文件 IO 和 Effect。

**验收**：miao/core 现有 edit/apply_patch 测试全绿；在 12k/150k 行样本上 diff 不劣化且峰值内存下降；长行用例耗时不高于当前。

**PoC 结果（已实现，含一次优化迭代）**

代码在 `crates/miao-native/`：`src/lib.rs` 移植了 9 个 replacer、`replace()`、`diffStats`、`unifiedPatch`，用 napi-rs 暴露；`bun run build.ts` 产出 `miao-native.node`。纯函数，不碰 IO / Effect。

- 一致性：12 个 Rust 单测 + 18 个 JS 对比测试全过，含 400 例随机语料；`unifiedPatch` 与 jsdiff 逐字节一致。
- 匹配（12k 行）：exact native 约 0.16 ms vs TS 约 0.23 ms（1.4x）；模糊缩进约 0.41 ms vs 约 0.82 ms（2.0x）。
- 全流程（匹配 + diff 统计）：native 约 1.9–2.2 ms vs TS 约 2.0–2.6 ms，被 diff 主导（`similar` 约等于 jsdiff）。
- 病态超长行：约 10 ms vs 约 21–30 ms（2–3x）。
- `apply_patch` 的 `deriveNewContents`（20k 行文件、命中点靠后，触发 4 轮 seek）：exact native 约 1.3 ms vs TS 约 1.7 ms（1.3x）；trim 轮约 1.8 ms vs 约 3.5 ms（2.0x）；unicode 归一化轮约 5.2 ms vs 约 13 ms（2.5x）。
- git 状态（2200 文件、400 处变更）：`gix` 原生 `gitStatus` 进程内约 5.6 ms；snapshot 现在用的 `git diff-files` + `git ls-files` 两个子进程约 13.5 ms（约 2.4x）；`git status --porcelain` 约 8.1 ms（约 1.4x）。
- 沙箱（macOS seatbelt，`miao-run`）：workdir 内写入放行、外部写入被拒（Operation not permitted）；默认禁网、`--allow-network` 恢复 HTTP 200；普通命令（如 `git status`）照常运行。这是规则式权限做不到的进程级隔离。误杀通过 `--allow-path` 补白名单，或 `--compat`（allow default + 只禁敏感路径和网络）兜底；接入侧用 `--deny-report` 回传被拒路径，`runSandboxed` 询问用户后带 `--allow-path` 重试。
- search 不单独做：`grep/glob` 已走 `rg` 二进制，fuzzy 走 `@ff-labs/fff-*` 原生库，增量很小。

**一次优化迭代值得记下来**：第一版 native 在典型场景反而比 TS 慢。原因不是语言，也不是 NAPI 边界（597 KB 字符串 echo 只要约 0.08 ms），而是 `str::find`/`str::rfind`（std two-way）比 JS 引擎的 SIMD `indexOf` 慢（0.38 / 0.45 ms vs 约 0.05 ms），且 `slice_span` 为了切一小段块把整个文件 `join` 了一遍。改用 `memchr::memmem` 搜索、用从 `index + 1` 向前的唯一性检查替代 `rfind`、直接对原内容切片后，所有场景 native 都快于 TS。`deriveNewContents` 也做了同类处理：原始行保持为 `&str`（不再逐行 `String` 分配），替换直接拼进输出，diff buffer 预分配，不再逐行 `format!`。改完后 exact 从“略慢（0.93x）”变成 1.3x，trim 也从 1.5x 提到 2.0x。

结论：行为正确，优化后典型与病态路径都领先；但全流程被 diff 主导，端到端收益仍有限。未接入生产，`tool/edit.ts` 仍走 TS 与 jsdiff。

### 已落地的 native 模块（PoC，全部纯函数，MIAO_NATIVE 门控 + TS 回退）

每个函数都带 Rust 单测 + JS parity 测试，parity 不许跳过（`MIAO_NATIVE_REQUIRED=1`）。

| 分类 | 函数 | parity 对象 |
|---|---|---|
| 文本 | `replaceOnly` / `applyEdit` / `diffStats` / `unifiedPatch` / `deriveNewContents` | JS `edit`/`jsdiff`（逐字节） |
| 文本 | `detectLineEnding` / `normalizeLineEndings` | TS 参考实现 |
| 文本 | `countTokens`（o200k / cl100k） | `gpt-tokenizer` |
| 文本 | `sha256Hex` / `blake3Hex` | Node crypto / BLAKE3 已知向量 |
| Git | `gitStatus` / `gitRevParse` / `gitBlob` / `gitWorktreeChanges` / `gitMergeBase`（均含 Async） | `git status` / `rev-parse` / `show` / `diff --name-only` / `merge-base` |
| Git | `gitDiff`（标准 unified diff） | `git apply` 往返（应用后逐字节相等）——**语义 parity，不追求与 `git diff` 字节一致** |
| 遍历 | `walkFiles`（`ignore`+`globset`，尊重 `.gitignore`） | 递归列目录 + gitignore 行为 |
| Shell | `shellAnalyze`（原生 tree-sitter，bash/powershell） | TS `shell/extract.ts` 的 wasm 抽取（parts/tokens/source） |
| 沙箱 | `miao-run`：macOS seatbelt + Linux landlock（写白名单 + TCP 默认禁） | 行为测试（写白名单 / 禁网） |

性能：`git rev-parse` native ~0.2–0.5 ms vs 子进程 ~5–9 ms（约 20x）。全部未接入生产。

### 尚未落地的模块与原因

- **#2 沙箱跨平台**：**Linux 已落地并验证**（xx01，内核 6.17）：landlock 写白名单 + TCP bind/connect 默认禁，`--allow-network` 放行；集成测试在 Linux CI 跑。**Windows 未做**（需 AppContainer/job object + Windows runner）。
- **#3 diff 算法升级（`imara-diff` 替换 `similar`）**：会改变 hunk 边界，破坏与 jsdiff 的逐字节 parity；与"无损"原则冲突，**不做**。
- **#6 tree-sitter 原生**：**已落地** `shellAnalyze`（bash/powershell，parity 对 `shell/extract.ts`）。TUI 高亮（`parsers-config.ts` 的多语言 wasm）仍不做。

### 第二步：看指标再决定

- SQLite 会话存储/迁移/检索（有收益，但数据模型绑在 Effect-Schema/Drizzle 上，风险高，先做只读索引而不是替换存储层）
- tree-sitter 原生解析（去掉 WASM 开销，范围小）
- token 计数、图像处理（收益有限）

只有被内存或大仓性能明确卡住时才动。

### 第三步：协议化 headless engine（长期方向）

仓库已经有干净的 `Schema → Protocol → Server` 分层和 HttpApi/SSE。长期可以定义一个版本化核心协议，让一个 Rust headless engine 实现同一协议，TS 壳逐步变薄。这是唯一现实的全 Rust 路径，但要先立协议、再谈语言。现在不做。

## 第一步怎么落地

**接口形态**：默认 `napi-rs`（Bun 支持 NAPI），需要窄接口时退到 `bun:ffi` + `cdylib` 的 C ABI，避免 Node ABI 重建。

**沙箱单独走 sidecar**：seccomp/landlock 必须包住子进程，不能包宿主。所以做一个 `miao-run` 小可执行文件，`AppProcess` 改成经它 exec。

**crate 选型**（初稿）：

| 模块 | crate |
|---|---|
| diff/patch | `similar`、`imara-diff`、`diffy` |
| pty | `portable-pty` |
| 沙箱 | `landlock`、`seccompiler` |
| 搜索 | `grep`、`ignore`、`globset`、`walkdir` |
| git | `gix` |
| tree-sitter | `tree-sitter` + 对应 grammar |

**边界约定**：native 库只做纯计算和进程原语，不做 IO 编排、不碰 Effect、不持有会话状态。所有调用从 TS 侧显式传入输入、显式返回输出。

## 验收标准

每一步合并前必须满足：

- 行为等价：现有 miao/core 测试全绿，尤其是 edit/apply-patch 的用例。
- 内存：长会话 RSS 相对基线明显下降（先量基线再定阈值）。
- 延迟：搜索、diff 在真实大仓库上不劣于当前实现。
- 崩溃隔离：native 侧 panic 不能带崩主进程。
- 分发：macOS/Linux/Windows 三平台能构建，不引入运行时依赖。

达不到就不合并，保留 TS 实现作为回退。

## 我明确不做的

- Provider / AI SDK（`llm/protocols`、`miao/provider`、`core/github-copilot`）
- TUI 渲染（`tui`）
- 插件宿主 / SDK / codemode
- Server / HttpApi / SSE / 路由，MCP/ACP/LSP 传输
- Effect 运行时、DI、observability、CLI 框架

这些要么是网络 IO，要么是 JS 生态垄断，要么是框架强耦合。整体重写“不划算”的印象，几乎全部来自这一层。

## 风险

- **双栈维护**：native 库和 TS 回退同时存在，接口一改要两边同步。用行为等价的测试兜底。
- **构建复杂度**：给三平台预编译 native 产物会加重 CI，需要设计好缓存和发布。
- **fff 已原生**：搜索这块的增量可能不如预期，先用基准测，不行就砍掉。
- **Effect 依赖**：任何 native 边界都要绕开 Effect，否则会把框架语义泄漏进 Rust。

## 下一步

把第一步的四个模块精确到「具体文件、函数、crate、接口签名、预计行数」，做一份可执行的 PoC 清单，从 diff/patch 开始，因为它最容易用现有测试验证。
