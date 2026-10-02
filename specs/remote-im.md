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

## 连接器框架与 TUI `/remote`（设计稿，2026-10-02）

目标：新接一个 IM（QQ、企业微信、飞书、Telegram、钉钉……）只写一个连接器模块，登录、配对、凭证、状态、
TUI 和 CLI 界面全部复用；用户在 TUI 里输入 `/remote` 就能扫码接入、看状态、断开。

### 连接器（Connector）

现在的 `Channel` 只管「收发」，登录逻辑写死在微信里。连接器把一个 IM 的全部差异收拢到一处：

```ts
export const qq = defineConnector({
  id: "qq",
  name: "QQ 机器人",
  capabilities: { buttons: false, push: true, maxLength: 2000, replyWindowMs: 60 * 60_000, repliesPerInbound: 4 },
  // 登录 = 一串步骤，界面只负责渲染步骤，不认识具体 IM
  login: async function* (ctx) {
    const task = await createBindTask(ctx)
    yield { type: "qr", content: task.url, hint: "用手机 QQ 扫码，选择或新建机器人后点「连接到第三方平台」" }
    const bound = await waitForBind(task, ctx)
    yield { type: "done", account: { id: bound.appId, label: "QQ 机器人" }, owner: bound.userOpenid, credentials: bound }
  },
  // 凭证 → 可运行的 Channel
  connect: (credentials, ctx) => createQQChannel(credentials, ctx),
})
```

- **登录步骤类型**：`qr`（二维码，内容为 URL 或字符串，可附提示）、`code`（让用户输入手机上显示的数字）、
  `form`（填 token / AppID / Secret，可标记 secret）、`open`（打开一个网页，例如开放平台）、`progress`（文字进度）、
  `pair`（显示一次性配对码，见下）、`done`（返回账号与凭证）、`error`。CLI、TUI、以后的网页和手机 App 都只实现这
  一组步骤的渲染，新增 IM 不用改界面。
- **主人认证（谁能遥控）**，按连接器能力二选一：
  - 扫码即确定主人（微信 iLink 返回扫码者 `ilink_user_id`）：`done` 里直接带上 `owner`。
  - 扫码/填 token 只创建了机器人、不知道谁是主人（Telegram、飞书；QQ 的扫码绑定会返回 `user_openid`，不需要配对）：登录后出一个 6 位**配对码**（`pair` 步骤，
    同时显示配对二维码/深链，例如 Telegram 的 `t.me/<bot>?start=<码>`），10 分钟内第一个向机器人发送该码的人成为主人，
    之后只认这个人。配对码一次性、可重新生成。
- **凭证与状态**：`remote-auth.json` 改为 `{ <连接器 id>: { <账号 id>: 凭证 } }`（兼容读取现有微信格式并迁移），
  0600；每个账号的游标/窗口/推送用量放 `~/.local/state/miao/remote/<连接器>/<账号>/`。
- **注册**：内置连接器在 `packages/remote/src/connectors/<id>/`；第三方连接器是导出 `defineConnector(...)` 的 npm 包，
  在配置 `remote.connectors: ["miao-connector-dingtalk"]` 里列出即可加载（与 `plugin` 一样走 npm 安装与缓存）。
  连接器只依赖 `@miao/remote` 暴露的类型与工具（HTTP、WebSocket 重连、切分、去重、文件存储），不碰 miao 内核。
- **一致性测试套件**：`@miao/remote/testing` 提供 `connectorConformance(connector, fakeServer)`，跑同一组用例
  （登录步骤收尾、收发、切分、去重、断线重连、窗口与预算、主人校验）。新连接器配一个假服务就能复用，降低接入成本。

### `miao remote` 守护进程的控制接口

TUI 需要能管理正在运行的 `miao remote`。守护进程本来就跑着 miao 服务，在它上面加一组只在 remote 模式开启的路由：

| 路由 | 作用 |
|---|---|
| `GET /api/remote` | 守护进程状态、各连接器与账号：已连接/需重新登录/未配对、今日推送用量、待取结果数、最近错误 |
| `POST /api/remote/login/:connector` | 开始一次登录，返回 flow id |
| `GET /api/remote/login/:flow/event` | SSE 推送登录步骤（二维码、配对码、完成、出错） |
| `POST /api/remote/login/:flow/input` | 回填 `code` / `form` 步骤 |
| `DELETE /api/remote/account/:connector/:account` | 断开并删除凭证 |
| `POST /api/remote/account/:connector/:account/pair` | 重新生成配对码 |
| `POST /api/remote/account/:connector/:account/test` | 给主人发一条测试消息 |

改 Protocol 后按约定在 `packages/client` 运行 `bun run generate`。CLI 的 `miao remote login <连接器>` 也改走同一套步骤，
守护进程没跑时在本进程内完成登录。

### TUI `/remote`

在命令面板注册 `remote`（`slashName: "remote"`，仿照 `/mcps` 打开对话框）：

```
┌ 远程遥控 ───────────────────────────────────────────────┐
│ 守护进程  ● 运行中 127.0.0.1:4097（launchd）             │
│                                                          │
│ 微信 ClawBot   ● 已连接  今日推送 1/4  待取 0           │
│ QQ 机器人      ○ 未接入                    [回车 接入]   │
│ Telegram       ○ 未接入                                  │
│ 飞书           ○ 未接入                                  │
│                                                          │
│ 当前 TUI 没有连到守护进程：这里的会话只能在手机上查看。 │
│ [a] 在守护进程里打开当前会话   [i] 安装常驻  [l] 日志    │
└──────────────────────────────────────────────────────────┘
```

- 选中一个连接器回车：按登录步骤渲染。二维码用半格字符直接画在对话框里（与 CLI 共用 `uqr`），`form` 步骤用输入框，
  `pair` 步骤显示配对码和二维码，`done` 后自动回到列表。
- 已连接的账号可以：发测试消息、重新配对、断开、查看推送用量与待取结果。
- 守护进程没运行：提示并提供「安装常驻」（写 launchd plist，显示一条需要用户确认执行的 `launchctl` 命令）或
  「前台启动」（在新的终端标签页运行 `miao remote`）。不在 TUI 里静默拉起后台进程。
- **单写者**：当前 TUI 若不是 attach 到守护进程，对话框提示「这里的会话在手机上只读」，并提供「在守护进程里打开当前
  会话」：用守护进程的地址重新 attach 当前会话。跨进程 fencing（路线图 Phase 2）完成后去掉这条限制。
- TUI 怎么找到守护进程：配置 `remote.port`（默认 4097）→ 探测 `GET http://127.0.0.1:<port>/api/remote`，带服务密码。

### QQ 机器人连接器

依据：QQ 开放平台 [Agent 接入](https://bot.q.qq.com/wiki/agent-qqbot/)（2026-08-26）推荐第三方 Agent 用扫码绑定，
官方 Node SDK `@tencent-connect/qqbot-nodejs@1.0.4`（MIT）、OpenClaw 官方插件 `@tencent-connect/openclaw-qqbot@2.0.4`、
Hermes（MIT）实现。扫码 SDK `@tencent-connect/qqbot-connector` 是 `UNLICENSED` 且混淆，**不依赖它**，协议约 40 行自己实现。

**扫码绑定（无需用户复制任何东西，主人在扫码时确定）**

1. 本地生成 32 字节随机 key；`POST https://q.qq.com/lite/create_bind_task {key}` → `task_id`。
2. 二维码内容 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&source=miao&_wv=2`。用户在手机 QQ 里选已有机器人
   或新建一个（一个 QQ 号最多 5 个），点「连接到第三方平台」。扫码页默认显示「第三方机器人」。
3. 每 2 秒 `POST https://q.qq.com/lite/poll_bind_result {task_id}`：`status` 1 等待 / 2 完成 / 3 过期（重建任务、刷新二维码）。
4. 完成时返回 `bot_appid`、`bot_encrypt_secret`、`user_openid`；secret 用 key 做 AES-256-GCM 解密（IV 12 字节 + 密文 + Tag 16 字节）。
   `user_openid` 即主人，只接受它的消息。

注意：在绑定页选一个「当前在线」的已有机器人，会断开它原来接的服务；`/remote` 里提示用户新建一个专用机器人。

**收发（标准 QQ 机器人 API，凭证任何客户端可用）**

- 鉴权：`POST {api}/app/getAppAccessToken {appId, clientSecret}` → `access_token`（≤7200 秒，`expires_in` 可能是字符串），
  提前 min(5 分钟, 剩余 1/3) 刷新；请求头 `Authorization: QQBot <token>`。官方 2026-08-10 起域名统一为 `api.bot.qq.com`，
  社区实现仍用 `bots.qq.com` / `api.sgroup.qq.com`，域名做成可配置，默认新域名，失败时回退。
- WebSocket 网关：`GET {api}/gateway` 取地址；Hello(10) → Identify(2) `{token, intents: (1<<25), shard:[0,1]}` 或
  Resume(6) `{token, session_id, seq}`；按 `heartbeat_interval` 发 Heartbeat(1)；`session_id` 与 seq 落盘。
  关闭码 4009 可续连，4006/4007 重新 Identify，4914（已下架）/4915（已封禁）停止并标记需要重新扫码；其余指数退避 1–60 秒。
  Bun 原生 WebSocket，不引入 `ws`。
- 收：`C2C_MESSAGE_CREATE`（`id`、`author.user_openid`、`content`、`attachments`），同一消息可能重复推送，按消息 id 去重。
  首版只做私聊；群聊（`GROUP_AT_MESSAGE_CREATE`，需 @）留到以后。
- 发：`POST {api}/v2/users/{openid}/messages`。被动回复带 `msg_id`，同一 `msg_id` 多次回复 `msg_seq` 递增；先用
  `msg_type: 2` 原生 markdown，遇到权限错误回退 `msg_type: 0` 纯文本；处理中发 `msg_type: 6` 输入中。
- 窗口与限额（官方「消息收发概述」2026-07-21）：单聊被动回复 60 分钟内、每条最多 4 次（同页另一处写 5 分钟，按保守值实现：
  超过 5 分钟优先改发主动消息）；主动消息每用户每天 1000 条、单关系 20 条/分钟。超窗或回复次数用完就直接发主动消息，
  只有在用户关闭「允许主动发送」（40054013）或超频（40034100）时才退回「待取结果」。所以 QQ 上「结束/出错/审批」
  都能及时推送，不像微信那样需要 `/r` 取结果。

### 实施顺序

1. 连接器框架：`defineConnector`、登录步骤、配对码、凭证迁移、一致性测试套件；把微信改造成第一个连接器（行为不变，
   现有测试全过）。
2. QQ 连接器 + 假 QQ 服务 + 一致性测试。
3. 守护进程控制路由 + 生成 client；`miao remote login` 改走步骤。
4. TUI `/remote` 对话框（列表、扫码、表单、配对、断开、守护进程状态、在守护进程里打开当前会话）。
5. 文档与真机验收（微信、QQ）。之后按同一模式接 Telegram、飞书、企业微信智能机器人。

### 实现状态（2026-10-02）

步骤 1–4 与文档已实现，真机验收（微信、QQ 扫码，TUI `/remote`）未做。

- **代码位置**：`packages/remote/src/connector.ts`（`defineConnector`、登录步骤、`callbackLogin` 把回调式登录转成步骤）、
  `accounts.ts`（凭证文件、按账号的状态目录、旧格式迁移）、`host.ts`（把账号变成 Channel、主人闸门、配对码、登录流程、状态）、
  `load.ts`（第三方连接器）、`testing.ts`（`@miao/remote/testing` 的 `connectorConformance`）、`builtin.ts`；
  内置连接器在 `src/connectors/wechat/`、`src/connectors/qq/`（含 `fake-qq.ts`）。控制路由的协议在
  `packages/protocol/src/groups/remote.ts`，处理在 `packages/server/src/handlers/remote.ts`，服务接口
  `packages/server/src/remote-control.ts`；TUI 对话框在 `packages/tui/src/component/dialog-remote.tsx`。
- **凭证与迁移**：`remote-auth.json` 为 `{ 连接器: { 账号: { label, owner, pair?, needsLogin?, savedAt, credentials } } }`，0600 原子写，
  同一进程内的读改写串行。旧的 `{ wechat: Credentials }` 读取时直接兼容；`miao remote` 各子命令启动时迁移一次：改写凭证文件、
  把 `wechat-<bot>.cursor/tokens/status.json` 搬到 `state/remote/wechat/<bot>/`，并把路由状态里的用户键 `wechat:<用户>`
  改成 `wechat/<bot>:<用户>`（Router 的通道 ID 现在是 `<连接器>/<账号>`），编号、当前会话、待取结果都保留。
- **主人与配对**：主人闸门在 host 里，Router 的 `allow` 也改成按 host 查询。配对码 6 位、10 分钟有效、一次性；收到 10 次错误的
  6 位数字即作废（防穷举），可重新生成；接受 `123456`、`/start 123456`、全角数字。**重新配对时旧主人在新码被使用前仍然有效**（保守，
  避免配对期间失联）。登录时已确定主人的连接器（微信、QQ）不提供重新配对，换主人要重新登录。没有路由的进程（CLI 登录）只为收配对码
  临时启动通道，配对完成或过期后关闭。
- **第三方连接器**：`remote.connectors` 里的 npm 包走与插件相同的 `Npm.add` 安装与缓存，本地路径（绝对、`./`、`~/`、`file:`）直接导入；
  模块导出的所有 `defineConnector(...)` 都会注册，与已有 id 重名的跳过并记日志。第三方连接器的设置放 `remote.settings.<id>`。
- **一致性套件**：经真实 host 跑（登录步骤收尾、凭证不出现在步骤里、主人或配对、收发、陌生人与重复消息被丢弃、按 `maxLength` 切分、
  断线重连、能力声明与主动推送）。微信、QQ 和一个测试用的配对型连接器都通过。
- **QQ 的取舍**：
  - 对 Router 不声明回复窗口和推送预算，由通道自己决定被动还是主动：被动回复只在入站后 **5 分钟内、每条最多 4 次**（文档同页
    60 分钟与 5 分钟取保守值），`msg_seq` 每次递增；之后改发主动消息，本地按每用户每天 1000 条、每分钟 20 条计数。被动回复被拒
    （40034005/40034024/40034128）时改发主动；40054013（用户关闭主动消息）、40034100（超频）让发送失败，Router 照常把结果放进待取。
  - 先发 `msg_type: 2` markdown，遇到 markdown 权限/格式错误码（40034008–40034011、40034124、40034127）回退纯文本并记住；
    `remote.qq.markdown: false` 可直接用纯文本。风险：QQ markdown 对单个换行的渲染未在真机确认。
  - 域名：未配置 `remote.qq.api` 时先用 `api.bot.qq.com`，网络失败/404/5xx 时依次回退 `bots.qq.com`（取 token）和
    `api.sgroup.qq.com`（其它接口），回退成功后粘住；配置了就只用配置的地址。扫码绑定的主机可用 `remote.qq.portal` 改。
  - Token 提前 min(5 分钟, 有效期的 1/3) 刷新（官方 SDK 用「剩余时间的 1/3」，那个式子永远成立，等于不提前）。401 时清缓存重取一次。
  - 网关：4009/op 7/op 9(true) 续连，4006/4007/4900–4913/op 9(false) 清会话重新 Identify 并重取 token，4004 重取 token，
    4008 等 60 秒，4914/4915 停止并标记需要重新扫码；心跳未被确认视为半开连接，断开后续连。`session_id` 与 seq 存
    `gateway.json`，重启后先 Resume。
  - 扫码：二维码过期最多刷新 3 次；`user_openid` 缺失时退回配对码。
- **守护进程控制接口**：在设计表格之外加了 `DELETE /api/remote/login/:flow`（取消登录）。路由走服务密码鉴权，只有 `miao remote` 把
  控制对象交给服务时才有效，其它服务（`miao serve`、TUI 内嵌服务）一律 404。`miao remote login` 先探测 `remote.port`，守护进程在跑就通过它
  登录（新账号立即生效），否则在本进程完成；`miao remote status` 优先读守护进程的实时状态，并显示守护进程是否在运行。
  **`miao remote` 仍然在没有任何账号时拒绝启动**（行为不变），所以第一个账号要先用 CLI 登录，之后才能在 TUI 里接入更多。
- **TUI `/remote`**：列表、状态（每 3 秒刷新，有变化才重绘）、回车接入（二维码用半格字符、白模块黑底绘制，与 CLI 共用 `uqr`）、
  `code`/`form` 用输入框（**secret 字段没有遮挡**，输入框组件不支持，界面会提示）、配对码与配对二维码、测试消息、重新配对、重新登录、断开（二次确认）。
  守护进程没运行时只显示「前台启动」「安装常驻」要执行的命令（`miao remote install` + `launchctl bootstrap …`），不执行任何命令。
  **「在守护进程里打开当前会话」只给出命令**（`miao attach http://127.0.0.1:<port> --session <id>`，需先退出当前 TUI），没有做原地重新 attach。
- **测试**：`packages/remote/test`（accounts 迁移、host 登录流程与配对、第三方加载、一致性套件 ×3、QQ 扫码/加解密/token/域名回退/网关关闭码/
  Resume/心跳/收发策略/markdown 回退/输入中）；`packages/miao/test/remote`（QQ 端到端：被动确认、超窗主动推送、40054013 进待取；
  守护进程：控制路由、经守护进程登录、断开、非 remote 服务 404、无守护进程时 CLI 登录与状态）；`packages/tui/test/cli/tui/dialog-remote.test.tsx`；
  `test/server/httpapi-exercise` 覆盖新路由的 404。所有 remote 测试经只允许 127.0.0.1 的 fetch/WebSocket 守卫（`packages/remote/test/preload.ts`）。
- **未做**：真机验收；QQ 群聊（`GROUP_AT_MESSAGE_CREATE`）、图片与文件；Telegram、飞书、企业微信连接器；TUI 原地切换到守护进程。

真机验收步骤：

1. 微信：`miao remote login wechat` 扫码 → `miao remote` → 手机发 `/help`、`/new <项目> 写一句话`，确认回复与审批码；`miao remote status`
   显示「微信：<bot>，主人 …」与「轮询：运行中」。
2. QQ：守护进程运行时执行 `miao remote login qq`（或在 TUI `/remote` 选「QQ 机器人」回车），用手机 QQ 扫码、新建专用机器人、点「连接到第三方平台」
   → 列表显示「● 已连接」→ 在 QQ 私聊里发 `/help`；让一轮超过 5 分钟再结束，确认结果仍被推送；在 QQ 里关闭该机器人的主动消息后重复，
   确认结果进入待取、发 `/r` 能取回。观察 markdown 消息的换行是否正常，不正常就设 `remote.qq.markdown: false`。
3. TUI：在没有 attach 守护进程的 TUI 里输入 `/remote`，确认显示「这里的会话在手机上只读」和 attach 命令；守护进程未运行时只显示命令；
   选中已接入账号可发测试消息、断开。
