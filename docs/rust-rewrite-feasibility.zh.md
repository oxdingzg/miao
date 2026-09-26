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
