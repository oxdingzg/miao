# P1 核验批次 A — 结论记录

- 日期：2026-10-28
- 适用版本：HEAD `2e44580d6555`（完整 `2e44580d655565b68fa8b6bbf0f575df63fbdd1b`，2026-10-28 `style(engine): use is_none_or per the current clippy`）。全部 file:line 以该版本工作树为准；本次核验未提交。
- 性质：勾选依据记录。结论三档：可勾选（可立即勾）、可勾选附缺口（勾的同时登记缺口）、需补工作（不可勾）。

## 汇总表

| 编号 | 项目 | 结论 |
|------|------|------|
| RUS-01 | V2 投影合入链与回归（S2/S3/S4） | 可勾选，附缺口 |
| RUS-02 | TS runner 退役 | 需补工作 |
| CFG-03 | 配置热重载 | 需补工作 |
| CFG-05 | 窗口运行时生命周期 | 可勾选，附缺口 |
| AUTH-01 | 凭据存储与所有权 | 可勾选，附缺口 |
| SEC-03 | 审批、取消与输入结算 | 可勾选，附缺口 |
| SEC-04 | 沙箱隔离 | 需补工作 |
| SEC-06 | 密钥、日志与外部内容边界 | 可勾选，附缺口 |
| AUTH-03 | 登录全流程与连接故障诊断 | 可勾选（核验不完整处见正文） |
| CFG-06 | Location 路径边界 | 需补工作 |

---

## RUS-01 V2 投影合入链与回归（S2/S3/S4）

证据：

- 合入链：S2 #1501、S3 #1471、S4 #1478（specs s2:3、s3:3、s4:3）。
- 测试：`store.rs:19,44,373`；`lost_wake.rs:37`；`accuracy.rs:263`。
- 投影单写：`admission.ts:23-65` + `input-projection.test.ts`。

结论：**可勾选，附缺口**。缺口 = 缺 0.3.x 真实客户端回归记录（现仅有 0.2.26 `client-acceptance-2026-10-24.json`）。

## RUS-02 TS runner 退役

证据：

- TS runner 仍在 `session/runner/`（15 个文件），仍被 `execution/local.ts:42-48` 接入。
- 退役清点未产出。
- 回滚开关仍保留：`MIAO_INPUT_TS_ADMIT=1`、`--engine ts`。

结论：**需补工作**。退役范围未清点、未落地，双轨仍在。

## CFG-03 配置热重载

证据：

- 无热重载实现：无 watch、无 reload RPC。
- `refreshContext` 仅在连接时重建（`owners.ts:83`）。

结论：**需补工作**。

## CFG-05 窗口运行时生命周期

证据：

- `specs/window-runtime.md`（取代废弃的 runtime-lifetime / runtime-upgrades）。
- PRs #254–#270 合并 + 验收表 §6 十场景。

结论：**可勾选，附缺口**。缺口 = 当代代码回归证据（`session_fence.rs`、`execution/local.ts:92` claim）未系统核对。

## AUTH-01 凭据存储与所有权

证据：

- ADR-0009 Accepted。
- `credential.rs`：READ_ONLY 打开 + Debug 脱敏 + `set_sensitive` + daemon marker。
- `miao-credential/store.rs:132` claim、`:185` release + SQL 触发器 RAISE ABORT。
- 测试：`tests/ownership.rs`、`tests/daemon.rs`（release joins rotation、并发共享一次请求、RefreshRejected 行未动）。
- TS 侧 `daemon.ts` broker 观察者。

结论：**可勾选，附缺口**。缺口 = ADR 自认确定性检查不替代真实账号 provider 验收。

## SEC-03 审批、取消与输入结算

证据：

- `runtime.rs:957/:984` cancel / cancel_if；跨 runtime `store.request_cancel` 持久化。
- approval 过期/取消结算：`store.rs:2267-2305` + `runtime.rs:1123`。
- 测试：`approval.rs:119,213,263,428,580,640,682`；`guarded_cancel.rs:48`；`question.rs:169-210`；`process.rs:165`。
- `cancel_input` 按身份：`store.rs:553` + `host.rs:112`。

结论：**可勾选，附缺口**。缺口 = queue 输入保留侧测试未见 + 真实客户端回归记录未见。

## SEC-04 沙箱隔离

证据：

- `miao-sandbox` 三平台实现：seatbelt / Landlock ABI v3 / AppContainer（829 行）；`process.rs:176` enforced。
- CI 矩阵：macos、ubuntu 每 PR；Windows 仅 nightly。

结论：**需补工作**。缺口 = 按工具（bash / monitor / 文件写 / MCP / worker）× OS 的隔离边界映射不成文；「allow 不能绕过沙箱」显式测试未见。

## SEC-06 密钥、日志与外部内容边界

已核证据：

- TS `bash-token-pipeline.ts:39-45`：bash 输出脱敏管线。
- `model-io.ts:39`：`redactRequest` 对发往模型的请求统一脱敏。
- 引擎 `credential.rs:39-52`：`secret` 字段不参与 Serialize，`Debug` 输出 `[redacted]`；`web.rs:51` `set_sensitive(true)`。
- daemon 不持有密钥 material。

本次补核验（HEAD `2e44580d6555`）：

- (a) 引擎 Rust 侧 bash 工具输出脱敏：`grep -rinE 'redact|secret|sensitive' crates/miao-engine/src` —— 除 `credential.rs` 防泄漏与各 provider 发送侧 `credential.secret()` 用法外，**无任何针对 bash/工具输出的脱敏实现**。`bedrock_stream.rs` 中的 `redacted` 字段是 Bedrock 推理内容（RedactedContent）透传，与密钥脱敏无关。输出脱敏单点依赖 TS 侧管线与 `redactRequest`。
- (b) 导入信任边界测试：`grep -rin 'untrusted'`（packages + crates）—— 边界以声明为主：`crates/miao-engine/src/mcp.rs:462,468`、`tool_catalog.rs:61,113`（外部工具/资源返回内容为 untrusted data，不构成指令或授权）；`packages/core/src/mcp.ts:283`（annotations 为 untrusted hint）；`packages/llm/src/schema/messages.ts:216`、`protocols/shared.ts:156`。真实拒绝测试集中在 remote-control 通道：`secure-channel.test.ts:39`、`push-context.test.ts:27,37,42`、`hub.test.ts:90`、`host-endorsement.test.ts:23`。

结论：**可勾选，附缺口**。缺口：

1. 引擎 Rust 侧无 bash/工具输出脱敏；Rust→TS 传输路径无第二道防线，也未见「引擎侧输出必经 TS 管线」的端到端脱敏测试。
2. 「导入内容不得提升为指令/权限」无专项测试；现有测试仅覆盖 remote-control 通道，MCP 侧为提示词级声明。

## AUTH-03 登录全流程与连接故障诊断

已核证据：

- `crates/miao-credential/src/login.rs`：device flow 在 daemon 内执行，900s deadline；403/404 → pending 重试；非成功响应 → `LoginRejected` 终态；标准 OAuth，客户端不见 device secret / PKCE。
- `crates/miao-credential/tests/device_login.rs:72,124`。
- `doctor.rs:16` 连接故障诊断。

本次补核验（HEAD `2e44580d6555`）：

- `packages/tui/src/component/dialog-provider.tsx`（535 行）：**存在 OAuth 流程与错误呈现**。
  - `:12-14` 引入 `IntegrationsConnectOauthOutput`；`:88` 单 provider 认证流程（方式选择 → OAuth 或 key）；`:133` `method.type === "oauth"` 分支；`:146` `connectOauth(...)`。
  - `:153-154` 失败 toast；`:161-162` 错误对话框「OAuth authorization failed. Try /connect again.」；`:279-346` AutoMethod 轮询，`:345-346` 将 `status.status === "failed"` 的 message 透出；`:367`「Waiting for authorization…」等待态；`:375-414` CodeMethod 授权码输入，`:413-414`「Invalid code」。

结论：**可勾选**。核验不完整处：TUI 侧 device-flow pending→终态到 UI 状态的完整映射（含 900s 超时在界面的呈现）与 doctor 诊断 UX 未逐条走查；本次为静态确认 `connectOauth` 调用与错误呈现存在，未做真实账号登录回归。

## CFG-06 Location 路径边界

证据：

- location 层 + 测试：`location.test.ts:27`；`location-filesystem.test.ts:55`（词汇逃逸拒绝）；`location-mutation.test.ts:29-58`；引擎 `tests/directory.rs:6`（symlink 不跟随）；`engine-placement.ts:138` workspaceID 检查。

结论：**需补工作**。缺口 = Windows UNC / 长路径 / 大小写 / Unicode 专项验证缺失；跨层一致性无单一验收测试；依据链接仍指向废弃 spec。

---

## 可立即勾选（附缺口记录）

- RUS-01 —— 缺 0.3.x 真实客户端回归记录（仅 0.2.26）。
- CFG-05 —— 当代代码回归证据（session_fence.rs、execution/local.ts:92）未系统核对。
- AUTH-01 —— 确定性检查不替代真实账号 provider 验收。
- SEC-03 —— queue 输入保留侧测试未见；真实客户端回归记录未见。
- SEC-06 —— Rust 侧输出脱敏无第二道防线；导入信任边界无专项测试。
- AUTH-03 —— 可勾，但注明核验不完整处（TUI 状态映射、doctor UX、真实账号回归未走查）。

## 需补工作

- RUS-02：产出 TS runner 退役清点并完成退役（`session/runner/` 15 文件、`execution/local.ts:42-48` 接入点）；期间保留回滚开关 `MIAO_INPUT_TS_ADMIT=1`、`--engine ts`。
- CFG-03：实现配置热重载（watch + reload RPC；当前 `refreshContext` 仅连接时重建，`owners.ts:83`）。
- SEC-04：成文按工具 × OS 的隔离边界映射；补「allow 不能绕过沙箱」显式测试；评估 Windows 沙箱验证从 nightly 提升覆盖。
- CFG-06：补 Windows UNC / 长路径 / 大小写 / Unicode 专项验证；建立跨层一致性单一验收测试；修正依据链接指向废弃 spec 的问题。
