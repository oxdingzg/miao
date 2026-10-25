# Rust Phase 2：单内核迁移

状态：方案稿，2026-10-25。依据：当天的两次只读测绘（TS/Rust 所有权边界、TS runner 与 Rust
runtime 的功能差集）。Phase 3/4 的边界列在最后一节，本文只覆盖 Phase 2。

## 1. 现状（测绘结论）

miao 今天不是"一个内核 + 一层壳"，而是**按 Session 分派的两套执行内核**：

- Session 的属主由 placement 决定（`packages/core/src/session/engine-placement.sql.ts:8`，
  解析 `packages/core/src/session/routing.ts:38`）。`rust` placement 由引擎执行并持有状态；
  其余仍在 TypeScript。
- **两套 durable inbox**：TS `session_input`（`packages/core/src/session/sql.ts:154`，
  写入 `session/input.ts`）与引擎 `engine_input`（`crates/miao-engine/src/store.rs:162`，
  准入 `:2334`，promotion `:855`）。`session/input.ts:73` 对 native placement 直接拒绝，
  两侧没有共享收件箱。
- **两个 SQLite 文件、两套 schema**：产品库 `<Global.Path.data>/miao.db`
  （`packages/core/src/database/file.ts:20`，drizzle migration
  `packages/core/src/database/migration.ts:13`）；引擎库
  `<storageRoot>/<sha256(location)>.db`（`packages/server/src/handlers/session.ts:141`），
  自带 `PRAGMA application_id` 版本号（`store.rs:147`）。引擎只在迁移/搬运时打开产品库。
- **两套权限存储**：引擎 `engine_permission_grant` + `engine_permission_request_scope`
  （`crates/miao-engine/src/permission_grant.rs:116`，判定 `runtime.rs:4124`）；
  产品 `permission` 表（`packages/core/src/permission/sql.ts:7`，服务 `permission/saved.ts:29`）。
  引擎从不读产品表，所以 native Session 看不到项目级 "always allow"。
- **config 只在 TS 解析**（`packages/core/src/config.ts:49-161`）。引擎不读 `miao.json`，
  只接受 argv 与 TS 物化出来的临时文件（policy/hooks/MCP/LSP/formatter：
  `packages/miao/src/engine/product-*.ts`）。
- 边界本身已经不小：引擎暴露 64 个 RPC 方法（`crates/miao-engine/src/protocol.rs:221-533`，
  分派 `host.rs:44-481`），TS 侧接口 `packages/server/src/native-engine.ts:22`。

## 2. 目标不变量（迁移不得破坏）

1. durable 准入与模型执行分离：先写一行 durable input，再唤醒执行；prompt 在安全边界提升为可见消息。
2. 每个 provider turn 恰好一次显式 `llm.stream(request)`；续跑前重载投影历史。
3. Session 与 Location 的所有权显式；一个 Session 在同一时刻只有一个执行属主。
4. 关闭/重开窗口不能隐式重放 pending prompt。
5. 事件可按序重放：重连得到的 status 流与实时一致。

## 3. 门槛 G0：退掉 TS placement 之前必须补齐的能力

这是"能不能只留一个内核"的真正门槛，来自当天的功能差集审计。每项都要有可执行的验收，
不是"看起来有了"。

| # | 缺口 | 证据 | 验收 |
|---|---|---|---|
| G0-1 | Azure（deployments/Entra/api-key）、Vertex（Gemini、partner MaaS）、Bedrock Mantle 与长尾 `@ai-sdk/*` provider 只有 TS 路由；Rust 只会走宿主 loopback gateway（仅 Chat Completions，丢弃 reasoning/cache/response_format） | `product-routes.ts:480-556`；`provider-gateway.ts:34-45` | 逐个 provider 的等价路由测试：同一请求在两侧产生等价的 wire（含认证头、参数） |
| G0-2 | Code Mode `execute` 无 Rust 实现 | `tool/code-mode.ts:12`；`tool_catalog.rs:95` | 决定"移植"或"明确废弃"；不允许含糊留下 |
| G0-3 | 无重复输出守卫：长 prose/reasoning 打转不会被中和（工具调用打转已有界） | `runner/output-guard.ts:10`；`runtime.rs:2060` | 引擎侧等价守卫 + 重放同一段打转输出的回归测试 |
| G0-4 | 重试语义回退：不读 `Retry-After`、无抖动、无 self-heal 400 | `runner/provider-retry.ts:40-121`；`provider.rs:104-160,836` | 同一条 429/400 序列在两侧的尝试次数与退避分布一致 |
| G0-5 | 插件 `aisdk` provider 钩子在原生路由上不执行；缺每轮 session-affinity 头 | `plugin/host.ts:46`；`openai_responses.rs:268` | 原生路由下钩子被调用；头与实际 session 一致 |
| G0-6 | 行为差：max-steps 是"暂停"而非 TS 的收尾提示；历史里的 `@file` 引用 Rust 不内联；websearch 端点不同 | `runtime.rs:1430`；`materialize-files.ts:310`；`web.rs:24` | 逐项定调（对齐或书面接受差异），不允许默认沉默 |

S1 进度（2026-10-26）：G0-3 已完成。守卫在 `crates/miao-engine/src/output_guard.rs`，
对 SSE 归一化 delta（`provider.rs`）与 Bedrock 通知（`bedrock.rs`）共用同一份状态机；
回合停止时保留已流出的文本、记录 `output.repetition`、不重试、不派发迟到的工具调用，
历史里的打转输出只在 provider 请求副本中被替换。回归测试
`crates/miao-engine/tests/output_guard.rs` 用真实 SSE 重放同一段打转输出。

## 4. 切片

顺序按"先补能力、再删路径"，每片单独可发布、可回滚。

- **S1 门槛修复**（G0-1…G0-6）。只改引擎与原生产品侧，不动 placement 路由。
- **S2 单一 durable inbox**：所有 Session 的 prompt 准入统一走引擎 `admit`；TS 侧
  `session_input` 停止写入，保留只读投影直到 S4。验收：native 与 TS Session 的
  steer/queue 提升顺序在重放中一致；`session_input` 无新行。
- **S3 placement 收口**：新 Session 一律 `rust`；TS placement 退化为显式环境变量的应急回滚。
  验收：全量测试与 blackbox 在无 TS placement 的情况下通过；回滚开关有测试。
- **S4 存储合一**：引擎库成为会话状态唯一权威，产品库降为投影/索引；迁移脚本可反复执行。
  验收：旧库迁移后重放一致；降级回旧版本有明确拒绝路径。
- **S5 配置下沉**：`miao.json` 的优先级解析进入引擎，TS 只传目录与环境；删除
  `product-*.ts` 的临时文件物化。
- **S6 权限合一**：引擎 grant 表成为唯一存储，产品 `permission` 表变为投影；TS 判定路径删除。

S1 之后每一片都必须先证明"没有回退"，再删除旧路径；删除与新增不放在同一个 PR。

## 5. Phase 3 / Phase 4 边界

- Phase 3（ratatui TUI 重写）在 S3 之后才有意义：TUI 重写的前提是会话状态只有一个属主。
- Phase 4（plugin 兼容 + 发布/updater/signing 路径）依赖 G0-5 与 S5 的成果。
- 本文不承诺工期；每一片进入实现前单独出设计。

## 6. 不做什么

- 不在这次迁移里更换 provider 生态（保留 AI SDK 作为长尾兜底，直到对应原生路由有等价测试）。
- 不引入第二个引擎进程模型；不改变"每个存储路径一个引擎进程"的约定。
- 不为了"看起来像单进程"而把 TUI 与引擎塞进同一进程。
