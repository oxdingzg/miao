# miao remote：用 IM 遥控会话（设计稿）

状态：已定稿，2026-10-02。依据：`specs/architecture.md`（Phase 4 的 IM 客户端提前做最小版）、
微信 ClawBot / iLink 协议调研（`@tencent-weixin/openclaw-weixin@2.4.9` 源码与官方
`docs/protocol_zh_CN.md`）。

## 目标

在手机微信里对本机 miao 做四件事：看有哪些会话、切换/新建会话、发 prompt 并拿到结果、审批与中断。
同一套路由以后接飞书和 Telegram。

不做：流式进度推送、群聊、在 IM 里看 diff 全文、远程执行未经审批的工具。

## 总体结构

```
 微信 ──iLink 长轮询──┐
 飞书（后续）─────────┼─► miao remote（本机常驻，launchd）
 Telegram（后续）─────┘     ├─ Channel 适配器：收消息 / 发消息 / 输入中
                            ├─ Router：命令解析、当前会话、审批码、待取结果
                            └─ V2 client（回环 HTTP）──► 同进程的 miao 服务（= miao serve）
 TUI ──miao attach http://127.0.0.1:<port>──────────────────────┘
```

- `miao remote` 在一个进程里同时起 miao 服务和 IM 适配器。Router 只通过 V2 协议（生成的 client）操作会话，
  不直接调内核服务，符合「协议即契约」，以后挪到别的机器或换成 relay 都不用改 Router。
- **单写者约束**：会话执行协调目前只在进程内有效。要从微信驱动的会话，必须跑在 `miao remote` 的服务里；
  桌面上用 `miao attach` 连同一个服务来看和操作这些会话。单独启动的 TUI 里的会话，第一版只能在微信里
  `/list` 看到，不能驱动（Router 拒绝并提示）。跨进程 fencing 属于路线图 Phase 2。
- 服务只监听 127.0.0.1，固定端口（配置项，默认 4097），用现有的服务密码鉴权。

## 微信通道（iLink）

协议要点（已从官方插件源码核实）：

| 环节 | 做法 |
|---|---|
| 登录 | `get_bot_qrcode?bot_type=3` 取码 → 终端渲染二维码 → 每秒轮询 `get_qrcode_status`，处理 `scaned_but_redirect`、`need_verifycode`、`expired`（最多刷新 3 次）→ `confirmed` 拿到 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id` |
| 收消息 | `POST ilink/bot/getupdates`，带上次的 `get_updates_buf` 游标，35 秒长轮询；游标落盘；`-14` 表示 token 失效需重新扫码 |
| 发消息 | `POST ilink/bot/sendmessage`，回传该用户最近一条入站消息的 `context_token`，每次一个文本 item，按 2000 字切分 |
| 输入中 | `getconfig` 取 `typing_ticket`，处理期间每 5 秒 `sendtyping` 一次 |
| 标识 | `iLink-App-Id: bot`，`base_info.bot_agent` 自报 `miao/<版本>` |

必须按限制来设计的地方（社区实测，官方未确认）：

- 回复要在入站消息之后约 2 分钟内发出；每个 `context_token` 大约只能回 10 条。
- 主动推送（用户没先发消息）每天大约 5–6 条就会被限流，被限时重试会加重惩罚。
- 有「返回成功但消息没送到」的风控案例；返回里没有 `message_id` 视为可能丢失。
- 只能和扫码者本人一对一私聊，不支持群和按钮。

因此微信上的交互是「一问一答 + 待取结果」：

1. 收到消息立刻回一句确认（「#2 收到，处理中」）并发输入中状态。
2. 这一轮如果在窗口内结束，直接回结果摘要。
3. 超出窗口就把结果放进待取队列；只在「需要审批」和「这一轮结束/出错」时主动推一条短通知，
   每天主动推送有预算（默认 4 条），超出预算就只进队列。
4. 用户发任意消息（或 `/r`）时，先把待取结果一并回给他，因为这条入站消息带来了新的发送窗口。

封号/限流风险说明：腾讯没有明确允许或禁止第三方客户端；目前没有因此封微信号的报告，但有 bot 下行被风控、
几天到三周才恢复的报告。miao 会在 `miao remote login wechat` 时提示这一点。

## 会话路由（各通道共用）

每个 IM 用户有一个「当前会话」。普通文字发给当前会话；命令以 `/` 开头：

| 命令 | 作用 |
|---|---|
| `/list` | 列出会话：编号、项目名、标题、状态（运行中 / 空闲 / 等你审批 / 出错）、最后活动时间，等你的排在最前 |
| `/use 2` | 切换当前会话到 #2 |
| `/new miao 修一下 README` | 在项目 `miao` 里新建会话，可直接带第一条 prompt |
| `/projects` | 列出允许遥控的项目及其别名 |
| `#2 消息` | 发给 #2 而不切换当前会话 |
| `/stop` | 中断当前会话（`#2 /stop` 中断指定会话） |
| `/r` | 取回待取结果 |
| `/status` | 当前会话最近一轮的摘要：用了哪些工具、改了哪些文件、花费 |
| `/help` | 帮助 |

- 编号是给这个 IM 用户看的短编号，映射到真实 Session ID，存在 remote 自己的状态文件里，重启不变。
- 会话正在跑时，新消息按 V2 默认的 steer 送入（在下一个安全点插入）；`/queue 消息` 改为排队。
- 结果摘要：这一轮最后一段助手文字（截断到 2000 字以内）+ 一行统计（工具次数、改动文件数、耗时、花费）。

审批与问答：订阅被遥控会话的 `permission.v2.asked` 和 `question.v2.asked`。

```
【#2 miao】请求执行 bash：
  rm -rf dist && bun run build
回复 y7 允许一次 · a7 总是允许 · n7 拒绝
```

- 审批码是短编号，只对这个用户有效，超时（默认 30 分钟）作废，回复对应 `session.permission.reply`。
- 问答类（question 工具）把选项编号列出来，回复编号作答。

## 安全

- 只接受登录时扫码者本人（`ilink_user_id`）的消息，其余一律忽略并记日志。
- 只能遥控配置里列出的项目目录（`remote.projects`），`/new` 只能在这些目录里建会话，防止通过微信操作任意仓库。
- 远程发起的 prompt 不自动放行权限，照常走审批（审批也在微信里完成）；不提供 `--auto`。
- 凭证（`bot_token` 等）存 miao 现有的凭证存储，权限 0600；游标和路由状态存 `~/.local/state/miao/remote/`。
- 单实例锁：同一个微信 bot 只允许一个 `miao remote` 轮询。
- 入站消息去重（`from_user_id|message_id|seq|create_time_ms`，保留 5 分钟），出站 `client_id` 每次唯一。

## 命令与配置

```
miao remote                      # 前台运行（调试用）
miao remote login wechat         # 扫码登录，保存凭证
miao remote install              # 写 launchd plist 并启动（本机常驻）
miao remote uninstall
miao remote status               # 通道连接状态、今日主动推送用量、待取结果数
```

```jsonc
{
  "remote": {
    "port": 4097,
    "projects": { "miao": "~/workspace/code/github/miao", "mtty": "~/workspace/code/github/miao-term" },
    "wechat": { "push_budget_per_day": 4 }
  }
}
```

## 分阶段实现与验收

1. **Router + 假通道**（无网络）：命令解析、编号映射、审批码、待取结果、推送预算；用假 Channel 和真的
   V2 服务跑测试。验收：脚本化走通 list / use / new / 发 prompt / 收结果 / 审批 / 中断 / 重启后状态还在。
2. **微信适配器**：登录、长轮询、发送、输入中、`-14` 处理、去重；用本地假 iLink 服务做集成测试。
   验收：断网重连不丢不重；非扫码者消息被忽略；超出窗口的结果进待取队列。
3. **`miao remote` 命令与常驻**：launchd 安装、`miao attach` 联动、文档。验收：真机微信端到端走一遍上面的全部操作。
4. **飞书、Telegram**：复用 Router，它们有按钮和可靠推送，审批改用按钮，结束通知不受预算限制。

## 已定决策（参照同类产品）

1. **会话忙时默认 steer**，`/queue` 改为排队。Claude Code Remote Control 与 Codex 都把运行中的新消息插入当前一轮，
   miao TUI 的默认也是 steer，遥控端保持一致。
2. **主动推送三类事件**：需要审批、这一轮结束、出错；审批优先占预算。Claude Code Remote Control 与 Happy 都在
   「需要审批」和「完成」时推送。微信每日预算 4 条（iLink 社区实测 5–6 条即限流）；飞书和 Telegram 不设预算。
3. **项目白名单**：只能遥控 `remote.projects` 里配置的目录，`/new` 只能在这些目录里建会话。cc-connect 也是按配置的
   `work_dir` 管项目，切到任意目录要 `admin_from` 授权。
4. **单写者**：要从 IM 驱动的会话必须开在 `miao remote` 的服务里，桌面用 `miao attach`。Claude Code Remote Control
   连的是本地 CLI 进程里的会话，Codex 是单个 app-server 进程，Happy 包住 CLI 进程，都是一个会话只归一个进程执行。

## 实现状态（2026-10-02）

阶段 1–3 已实现，阶段 3 的真机验收和阶段 4（飞书、Telegram）未做。

- **代码位置**：`packages/remote`（`@miao/remote`，只依赖 `@miao/client`）放 Channel 接口、Router、微信适配器、
  单实例锁和 launchd plist 生成；`packages/miao/src/cli/cmd/remote.ts` 是 `miao remote` 命令；配置 schema 在
  `packages/core/src/config/remote.ts`（V1、V2 两套 schema 都已接入）。
- **文件**：凭证 `~/.local/share/miao/remote-auth.json`（0600）。没有放进 `auth.json`，因为那里的条目会被当成
  provider 密钥读进集成列表；做法同 `mcp-auth.json`。游标、context_token、通道状态、路由状态（编号、当前会话、
  审批码、待取结果、推送用量）和锁都在 `~/.local/state/miao/remote/`，均为 0600、原子写入。
- **单写者**：Router 订阅本服务的 `/api/event`，凡是在本服务的事件总线上出现过 `session.next.*` 事件的会话
  （在这里新建或执行过，包括 `miao attach` 进来的操作）才算「本服务的会话」，可以驱动；其余会话 `/list` 里标「只读」，
  驱动时拒绝并提示用 `miao attach` 打开后发一条消息。
- **新建会话带上模型**：`/new` 用全局配置的 `model` 显式建会话。原因：没有模型的会话在冷启动的 location 上解析
  默认模型时，插件还没把配置里的 provider 放进目录，会落到目录里第一个可用模型（测试里实测选中了无关的
  `vercel/...` 模型）。这是内核的问题，这里只做规避。
- **推送预算**：审批可以用掉最后一条预算；「结束/出错」通知要给审批留一条。超窗时完整结果进待取队列、只推短通知；
  主动推送失败或预算用完时只进队列。一次补发最多约 3 条消息的长度，其余提示 `/r` 继续。
- **审批与问答**：审批码 1–99 轮转，30 分钟过期；过期或重启后发 `/status` 会给仍在等待的请求重新发码。
  问答用 `q7 2`（多选 `q7 1,3`，多题 `q7 1;2`，也可直接写文字），`n7` 拒绝。服务事件流重连后会补发断线期间的
  审批请求。
- **iLink 细节**：`channel_version` 与 `iLink-App-ClientVersion` 报所核对的协议版本 2.4.9，`bot_agent` 报
  `miao/<版本>`；去重键 `from|message_id|seq|create_time_ms`（5 分钟）；游标在一批消息交给 Router 之后才落盘，
  宁可崩溃后重投也不丢；`ret=-2` 不重试；`-14` 停止轮询并在凭证里标记需重新登录，`miao remote` 遇到该标记以
  退出码 0 结束，避免 launchd 反复重启。
- **launchd**：`miao remote install` 只写 `~/Library/LaunchAgents/dev.mtty.miao.remote.plist` 并打印
  `launchctl bootstrap` 命令；plist 不含 `MIAO_SERVER_PASSWORD`。
- **未做**：图片/文件消息（回复「暂时只支持文字」）、IM 里调用 miao 自己的斜杠命令、飞书与 Telegram、跨进程 fencing。
- **测试**：`packages/remote/test`（问答解析、0600 原子写、launchd plist、iLink 协议细节、扫码登录含 redirect
  与验证码、长轮询断线与超时、游标持久化、`-14`、单实例锁、切分与 `ret=-2`）；`packages/miao/test/remote`
  （真实 `miao serve` + 假 LLM：list/use/new/定向发送/结果/审批/问答/中断/白名单/只读拒绝/重启保留/预算与待取；
  经假 iLink 的端到端；`miao remote` 命令本身）。

真机验收步骤：`miao remote login wechat` 扫码 → 在全局配置里写 `remote.projects` → `miao remote` →
在微信里依次试 `/projects`、`/new <项目> 写一句话`、`/list`、触发一次需要审批的 bash 并回 `y码`、`/stop`、
等两分钟以上再让一轮结束，确认收到「发 /r 取结果」通知并能取回 → 桌面 `miao attach http://127.0.0.1:4097`
能看到同一批会话。
