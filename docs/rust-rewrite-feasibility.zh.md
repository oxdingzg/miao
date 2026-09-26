# miao 用 Rust 重写的可行性评估

**语言 / Language:** [English](rust-rewrite-feasibility.en.md) | [中文](rust-rewrite-feasibility.zh.md)

## 结论先行

**全量 Rust 重写目前不可行；但“协议边界 + 局部原生”的渐进路线可行。**

以下内容基于仓库实际数据：文件数、行数、依赖面，以及哪些热点已经有原生绑定。

## 1. miao 到底是什么

非测试 TS/TSX 共 **2,474 文件 / ~49.5 万行**，但大部分不是“引擎”：

| 部分 | 规模 | 是否值得/需要 Rust 重写 |
|---|---|---|
| 引擎 `miao + core + tui + llm + server + schema + protocol + client + plugin` | ~17.6 万行 | 这才是重写对象 |
| `packages/app`（Solid/Vite）、`ui`、`console`、`stats`、`web/docs` | ~30 万行 | 前端，Rust 无意义 |
| `desktop`（Electron） | 124 文件 | 保持 |
| 测试 | miao 300 + core 160 + tui 53 文件 | 需要重写/重跑 |

引擎侧关键数字：`miao/src` 98 个运行时依赖、**528 个文件 import `effect`**、25 个 tool、26 个 CLI 命令、21 个 HttpApi group。

## 2. 为什么全量重写很难

1. **架构骨架是 Effect v4 beta**（Layer/DI、Fiber、Stream、Schema、结构化并发）。Rust 只有 tokio+serde，等于要先把一整套并发+DI+Schema 框架重设计，这不是翻译，是重新架构。
2. **AI SDK 生态是 JS 独占**：19 个 `@ai-sdk/*` provider + openrouter/gateway/gitlab/venice。Rust 侧要逐个重写流式 tool-call、reasoning 字段、图片、usage、OAuth device code……这是整个项目最重、最容易长期落后的部分。
3. **TUI 是自己的渲染器** `@opentui/core + @opentui/solid`，还有 shimmer 动画和插件 API；换 ratatui 会丢保真度和插件兼容。
4. **插件系统跑的是用户 TS/JS**，Rust 宿主里仍得内嵌 JS 运行时（deno_core/quickjs）或保留 Node。
5. **原生/WASM 依赖**：node-pty、@parcel/watcher、tree-sitter(bash/powershell)、photon、zip.js、drizzle/sqlite、MCP/LSP/ACP。
6. **Bun 编译已经产出单文件二进制**（还内嵌 Web UI 和 tree-sitter worker）——Rust “单二进制分发”的收益比想象中小得多。

## 3. Rust 到底能买到什么

- **内存**：会明显下降（Bun/Node 常驻几十~几百 MB）。
- **CPU/启动**：对“AI 编码工具”收益有限，瓶颈是模型网络延迟，不是本地 CPU。启动 Bun 已经够快。
- **安全沙箱/并发**：PTY、子进程监管、文件索引，Rust 确实更稳。

也就是说：**收益集中在少数性能/内存敏感模块，而非全局。**

## 4. 成本量级（粗估）

引擎 17.6 万行 TS，考虑重写框架+provider+TUI，Rust 侧大概率 **15–25 万行**，达到功能对等约 **6–18 人月**（不含 web/desktop/docs 与插件生态），且 provider/TUI 会持续追赶。风险和投入不成比例。

## 5. 建议路线（按推荐度）

1. **保持 TS 为主**（除非有明确的内存/沙箱硬指标）。
2. **局部原生**：把边界清晰的热点用 `napi-rs`/Bun FFI 写成 Rust——ripgrep 式搜索索引、diff/merge、tree-sitter 解析、git、PTY/沙箱监管、sqlite 索引。其余不动。这也是 `packages/miao/src/tool/*` 里最容易替换的一层。
3. **协议优先的长期方案**：你们已经有干净的 `Schema → Protocol → Server` 分层和 HttpApi/SSE。可以定义一个**版本化核心协议**，再逐步用一个 Rust “headless engine” 实现同一协议，让 TS 壳越来越薄。这是唯一现实的全 Rust 路径，但要先立协议、再谈语言。

**判定**：全量重写 = 不建议（高风险、耗时长、丢生态）；渐进原生 + 协议先行 = 可行且推荐。

## 6. 引擎按 Rust 收益排序

排序依据是**净收益**（性能/内存/战略价值 − 迁移成本/生态损失）。先给一个前提，它直接决定排序：

> 引擎里很多热点**已经是原生绑定**：搜索用 `@ff-labs/fff-*`、文件监听用 `@parcel/watcher`、PTY 用 `node-pty`、图像用 `photon-node`、SQLite 用 `bun:sqlite`。所以 Rust 的增量收益只落在「原生绑定覆盖不到 / JS 里 CPU 密集 / 需要沙箱」的地方，其余是 IO 或生态绑定，收益接近 0。

| 排名 | 模块 | 位置 | ≈规模 | 净收益 | 迁移成本 | 一句话理由 |
|---|---|---|---|---|---|---|
| 1 | **文本处理**：diff / patch / apply / edit / format | `core/tool/{edit,apply-patch}`、`miao/src/format`、`miao/tool/{edit,apply_patch}`、`session/revert-diff` | 4–6k | ★★★★★ | 低 | 纯 CPU 文本算法，生态无关，Rust 的 diff/patch 库更快更省内存 |
| 2 | **PTY / 子进程 / 沙箱** | `core/pty`、`AppProcess`、`miao/tool/{shell,bash}`、`miao/effect` | 1–2k | ★★★★★ | 低-中 | `portable-pty` + seccomp/landlock 沙箱是 Rust **独有战略价值**，JS 做不到 |
| 3 | **文件搜索 / 遍历 / 忽略规则** | `core/filesystem/{search,ignore,watcher,fff}`、`core/tool/{grep,glob,read}`、`miao/tool/{grep,glob,read}` | 2–3k | ★★★★☆ | 低 | ripgrep+ignore+globset 一套打通；但 fff 已原生，增量取决于其覆盖面 |
| 4 | **Git / worktree / 快照** | `core/git.ts`、`worktree`、`snapshot` | 1–2k | ★★★★☆ | 中 | `gix` 在大仓/高频 diff 上明显优于 JS 层；与 #1 同为文本密集 |
| 5 | **SQLite 存储 / 迁移 / 检索** | `core/database`、`core/session`、`miao/session`、`storage` | ~14k | ★★★☆☆ | 高 | `rusqlite/sqlx` 强，但 schema 绑在 Effect-Schema/Drizzle，重写数据模型成本大 |
| 6 | **tree-sitter 解析** | `core/tool/bash.ts`、`miao/tool/shell.ts` | <1k | ★★★☆☆ | 低 | 原生 tree-sitter 去掉 WASM 开销；范围小 |
| 7 | **token 计数 / 模型索引** | `llm/src`、model data | <1k | ★★☆☆☆ | 低 | `tokenizers` crate 更快；但对总延迟影响小 |
| 8 | **图像处理** | `image`、`photon` | <1k | ★★☆☆☆ | 低 | `image` crate；使用面很窄 |
| 9 | **权限 / 通配匹配** | `permission`、`minimatch` | <1k | ★★☆☆☆ | 低 | 规则匹配可原生；体量小 |
| 10 | **Server / HttpApi / SSE / 路由** | `miao/server`、`server`、`protocol`、`client` | ~13k | ★☆☆☆☆ | 高 | 网络 IO 主导，Effect HttpApi 生产力高，Rust 只赢内存 |
| 11 | **MCP / ACP / LSP 传输** | `miao/{mcp,acp,lsp}` | ~11k | ★☆☆☆☆ | 中 | JSON-RPC IO，瓶颈在外部进程 |
| 12 | **配置 / 项目 / 账号 / 认证** | `config`、`project`、`account`、`oauth` | ~8k | ★☆☆☆☆ | 中 | IO + 生态绑定 |
| 13 | **Provider & 模型协议** | `llm/protocols`、`miao/provider`、`core/github-copilot` | ~19k | **≤0** | 极高 | 19 个 AI SDK provider 是 JS 生态垄断，重写=长期追赶 |
| 14 | **TUI 渲染** | `tui` | ~28k | **≈0.5** | 极高 | OpenTUI/Solid + shimmer 动画强耦合，视觉保真和插件 API 全丢 |
| 15 | **插件宿主 / SDK / codemode** | `plugin`、`core/plugin`、`miao/plugin`、`codemode` | ~16k | **<0** | 极高 | 必须执行用户 JS/TS，Rust 里还得内嵌 JS 运行时 |
| 16 | **Effect 运行时 / DI / observability / CLI 框架** | `core/effect`、`miao/effect`、`miao/cli`、`core/config` | ~30k | **0（骨架）** | 极高 | 单独移植无收益，只有整体重写才动 |

## 7. 拆成三层看

**第一层：真该用 Rust（P0，约 8–13k 行，生态无关、边界清晰）**
- 文本：diff / patch / edit / format
- 进程：PTY / 子进程 / 沙箱
- 搜索：grep / glob / ignore / walk
- Git：仓库读写 / worktree / snapshot

这四块是**唯一净收益为正且能独立成库**的。它们几乎不依赖 Effect、不依赖 AI SDK、不依赖 UI，最适合做成一个 `miao-native` crate，用 napi-rs / Bun FFI 挂回来。

**第二层：看指标再决定（P1，约 16k 行）**
- SQLite 会话存储 / 迁移 / 检索（收益有，但数据模型重写风险高）
- tree-sitter、token 计数、图像

只有当你被内存/大仓性能明确卡住时才动，且优先做**只读索引**而非替换整个存储层。

**第三层：不要动（P2/P3，占引擎 70%+ 代码）**
- Server/HttpApi/SSE/路由、MCP/ACP/LSP、配置/账号/认证
- Provider/AI SDK、TUI、插件宿主、Effect 骨架

这些要么是网络 IO（Rust 赢不了），要么是 JS 生态垄断（重写=负收益），要么是框架强耦合（成本天价）。**全 Rust 重写的“不划算”几乎全部来自这一层。**

## 8. 结论

- 引擎里**净收益为正的只有第一层 4 个模块**；按收益排序是：**文本处理 > 进程/沙箱 > 搜索 > Git**。
- 全量重写之所以不可行，不是因为第一层难，而是因为第二、三层里 ~70% 的代码 Rust 拿不到收益、还会丢掉生态。
- 现实动作：把第一层抽成一个 Rust native 库（napi-rs/FFI 或 sidecar），其余保持 TS。这是投入产出比最高的切入方式。

如需下一步，可把第一层精确到「具体文件 → 建议 crate → 接口形态（FFI/napi/sidecar）→ 预计行数」，形成一份可执行的 PoC 清单。
