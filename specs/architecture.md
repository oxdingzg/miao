# miao 架构与路线图（2026 Q4）

状态：方案稿，2026-10-01。依据：`docs/research/2026-10-01-miao-research-and-plan.html`（本地调研报告：
用户痛点、功能矩阵、社区反馈、同步架构、内存剖析）与 `docs/research/2026-10-01-zcode-teardown.md`。

2026-10-06 生命周期修订：[随窗口运行方案与排期](window-runtime.md) 替代常驻 daemon、空闲保活和版本化 worker 路线。
下文 10-01 的现状数据保留其调查日期；本轮先落实窗口所有权、共享库保护和按需远程接入。

## 目标

驱动下面所有决策的产品目标：**mtty 手机 App，像 Claude 一样做会话同步**——在桌面开始的工作，
能在手机上跟进、插话、审批，任何设备都能接着做，而且不绑定模型厂商。

## 现状

要保留并放大的优势：

- prompt cache 可观测（warm/miss、TTL、Context Epoch），原生币种计费与预算停止——其他 agent 都没有。
- V2 durable inbox：入队与执行分离、steer 与 queue 语义、每会话串行执行、每个 aggregate 的事件 `seq`
  与回放（`GET /api/session/:id/event?after=`）。
- 多 provider：ChatGPT 订阅（Responses 持久 WebSocket）与国产 Coding Plan。

阻碍目标的债务（2026-10-01 实测）：

| 债务 | 证据 |
|---|---|
| 双运行时 | V1 仍承载 `--mini`、ACP 和旧路由；`db compact` 弄坏了 `--mini`，当天回滚 |
| 进程太重 | TUI RSS 1.3–1.5 GB（Codex 64 MB、Claude Code 184 MB）；两个 JSC VM 重复加载 1216 个模块；启动时把 6.6 MB 完整模型目录发给 TUI；gpt-tokenizer 被提前加载 |
| ID 回绕 | `packages/schema/src/identifier.ts` 把 `ms * 4096` 塞进 48 位，每 2^36 ms（约 795 天）回绕；上次 2026-08-14（即上游 opencode 大面积事故），下次 2028-10-17 |
| 协议不支持远程 | 只有一个全局 Basic 密码；全局 `/api/event` SSE 没有 id、不能续传；没有写者 fencing；没有推送 |
| 测试噪音 | `main` 上约 25 个已知失败，掩盖真正的回归 |
| 默认不安全 | 沙箱默认关；上游报告 bash 权限可被 `cd`、管道、heredoc、`env` 绕过 |

## 目标架构

一个内核，一套协议，多个客户端。

```
 客户端：TUI · --mini · miao run · ACP · 桌面/web · mtty 手机 · IM bot（飞书/企微/Telegram）
                          │  V2 协议（命令 + 可续传事件流，版本化）
 内核：  session runner · 工具 · 权限/沙箱 · LLM transport · 事件存储（SQLite）   ← 每次运行拥有，随窗口退出
 边缘：  relay（E2E 加密信封、游标、推送）—— 可选，用于不开 VPN 时的访问
```

原则（每条在路线图里都有可量化的门槛）：

1. **单一运行时。** 全部走 V2，删除 V1，之后 `db compact` 才安全。
2. **协议即契约。** 所有客户端（包括 TUI）只用 V2 协议；TS、Swift/Kotlin（经 Rust `miao-wire` crate）
   和 relay 共用生成的类型。
3. **内核随窗口运行。** 每次普通启动拥有固定版本的运行时，关窗一起退出；`/remote-control` 按需分享当前运行。
   `miao serve` 是显式前台入口；不设计 launchd/systemd 常驻服务。升级只影响后续启动。
4. **按需加载。** 模型目录、tokenizer、LSP、插件、Babel、MCP 都在第一次用到时才启动。
5. **事件日志是同步单元。** 每会话单写者（epoch fencing）；客户端带游标做只读复制。不做 CRDT 多写。
6. **默认安全。** 补上绕过漏洞后沙箱默认开；升级只认显式规则（0.0.31 已做）。
7. **provider 原生、缓存优先。** provider 支持时用持久/增量传输；前缀字节级稳定；系统 prompt 不放日期等
   易变内容。

## 远程/手机客户端需要的协议能力

| 能力 | 现在 | 需要 |
|---|---|---|
| 鉴权 | 一个 Basic 密码（`packages/server/src/auth.ts`） | 设备配对：一次性 QR → 每设备可吊销 token，带作用域（只读 / 可审批 / 可写）；设备列表 |
| 全局事件流 | `/api/event` SSE，无 `id`，只推实时，队列 256 | 每条事件 `id: <aggregate>:<seq>`；`Last-Event-ID` 或多会话游标订阅；缺口检测 → "请全量重同步"信号 |
| 写者 fencing | 进程内协调器 | 每会话 epoch/lease；被接管时给出明确关闭原因（类似 Claude 的 4090 / 409 epoch） |
| 审批 | `permission.v2.asked` 只推实时 | 持久化请求事件，先答者生效，超时策略，推送钩子 |
| 握手 | 无 | `initialize`：协议版本、能力、客户端在线状态 |
| 附件 | 已有 blob 存储 | 内容寻址上传，分块/断点续传，prompt 里按 hash 引用 |
| 推送 | 无 | 内核 notifier（需要审批、轮次结束、出错）→ relay → APNs/FCM；payload 最小化或加密；桌面有人时不推 |

## 路线图

每个阶段可以单独发布；每个阶段有门槛，过了才进入下一阶段。

### Phase 0 —— 稳定（约 2 周）

- 修 ID 回绕：扩大时间字段（或时间与计数器分开存），并保证跨 2026-08-14 边界的排序；用模拟回绕测试。
- 内存/启动 P0–P1（来自剖析）：TUI 只拉已连接 provider（完整目录按需）；`/command` 不带 skill 正文；
  `Token.count`、turndown、Babel/solid 转译改懒加载；`Database.path()` 放进轻量模块；logo 只改颜色、不重建节点。
- `main` 测试全绿：修复或隔离约 25 个已知失败，逐个写明原因。
- README 公开基线：启动到提示符、空闲 RSS、空闲 CPU、崩溃恢复结果。
- 门槛：空闲 RSS < 600 MB，启动到提示符 < 2.5 s，空闲 CPU < 1%，测试全绿。

### Phase 1 —— 单一运行时（约 3–4 周）

状态（2026-10-03）：V1 会话运行时已删除——`packages/miao/src/session`、`packages/miao/src/tool` 与旧
`/session/*`、`/permission/*`、`/question/*`、`/sync/*` 路由组不再存在；`--mini`、ACP（`packages/acp`，
只依赖 `@miao/client`）、`miao run` 都走 V2；日常库已压缩。尚未删除的未用上游包（web / console /
enterprise / stats / function / slack 等）与旧 JS SDK 属收尾工作。

- `--mini` 和 ACP 迁到 V2（ACP 放在只说 V2 的独立适配层里——日后可以用 Rust `miao-acp` 替换的接缝）。
- 删除 V1 会话/运行时代码和未使用的上游包（web、console、enterprise、stats、function、slack、infra，
  sdks/vscode 若不采用也删）。
- 然后压缩日常数据库（先备份，并在克隆库上冒烟测试每个入口）。
- 门槛：不再 import `packages/miao/src/session`；`--mini`、ACP（Zed）、`export` 在压缩库克隆上 e2e 通过。

### Phase 2 —— 远程就绪内核（约 3 周）

- 随窗口运行、按需远程接入、设备配对鉴权、可续传事件流、写者保护、持久化审批、`initialize`、附件、notifier（见上表）。
- 门槛：脚本客户端经历断网与内核重启后，事件不丢不重；可远程审批；协议有文档且版本化。

### Phase 3 —— mtty 手机 MVP（约 4–6 周）

- 先做 iOS，原生 SwiftUI，连接当前窗口开启的远程接入。
- 多 agent 收件箱（"谁在等我"）、会话列表/历史、实时流、发 prompt、传图、语音输入、审批/拒绝、中断、
  看 diff；每个会话一个 SwiftTerm 终端标签。
- 只做结构化 UI——不刮终端屏幕（Omnara 已放弃这条路）。
- 门槛：切换网络后 3 s 内重连；1 天浸泡测试零漏审批。

### Phase 4 —— relay、E2E、推送、IM（约 3–4 周）

- Rust relay（axum + tungstenite）只存储和转发带游标的加密信封；内核主动外连；扫码配对用 X25519 +
  AES-GCM（参照 Happy / Remodex）；APNs。
- 同一协议上的 IM 客户端：飞书、企业微信、Telegram bot。
- 门槛：relay 读不到内容（经验证）；推送延迟 < 5 s。

### Phase 5 —— 功能补齐与差异化（滚动推进，与 2–4 并行）

缺的 table stakes：产品化的 `/rewind`（代码 + 对话一起回退）、配置式 shell hooks、命名权限模式、
补完绕过后沙箱默认开、`/goal` 一等对象（可暂停/恢复、有预算、跨重启）、输入框体验（粘贴展开、
Shift-Enter、Ctrl-C 中断）、TUI 中文。

差异化：额度解释器（"为什么烧额度"：逐轮的 cache 重建与 context 增长，额度预测）；多账号 profile，
订阅 → API → 更便宜 provider 的 429/额度兜底；国产 Coding Plan 预设与 reasoning/thinking 字段归一化；
公开缓存友好审计数据；导入 Claude Code/Codex 会话。

不做：在第三方客户端里接 Claude/Google 订阅 OAuth（ToS 风险，opencode 已因此移除）；CRDT 多写；刮终端屏幕。

## Rust 放在哪里

1. `miao-wire`（随 Phase 2）：协议类型、E2E 加密、游标/副本逻辑——relay 与手机 App 经 UniFFI 共用；
   类型从 V2 Effect Schema 生成。
2. relay（Phase 4）。
3. 已有原生实现的工具层（沙箱、编辑）与 LLM transport。
4. 最后才是会话内核，协议不变（以 Codex 的 `ThreadStore` + app-server 分层为模板）。

剖析显示：Rust 内核能去掉 server VM（约 200 MB live heap、1.5 s import、1 s 实例启动），但去不掉 TUI
的 VM；要达到 Codex 级别的占用必须连 TUI 一起重写。Phase 0 先在 TypeScript 里拿回大部分启动 CPU 和峰值内存。

## 待决策

1. 先做 iOS 原生（建议），还是 RN 双端？
2. relay 部署：自有 VPS（建议，便于掌控 E2E）还是暂时只用 WireGuard？
3. IM 优先级：飞书、企业微信、Telegram？
4. 沙箱和 ChatGPT 持久连接何时默认开启？
5. 手机 App 收费方式（社区反感客户端订阅；买断或免费）。
