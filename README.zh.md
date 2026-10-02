<p align="center">
  <strong>miao</strong>
</p>
<p align="center">模型由你选，工作持续推进，少浪费上下文。</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>
<p align="center">
  <a href="https://mtty.dev/zh/miao">官网</a> · <a href="#快速开始">快速开始</a> · <a href="#为什么选择-miao">为什么选择 miao</a> · <a href="docs/guide.zh.md">使用指南</a> · <a href="https://github.com/oxdingzg/miao/releases">下载版本</a> · <a href="#相关项目">相关项目</a>
</p>

---

**miao 是一个开源 AI 编程代理，让你在终端里完成真实工程任务，也看清任务消耗了多少时间和费用。** 使用你选择的模型，让代理理解仓库、修改代码、执行命令并验证结果。

miao 基于 [opencode](https://github.com/anomalyco/opencode)，把重点放在模型周围的工程能力上：**上下文效率、持久化会话、代理协作，以及长任务的执行控制。** 目标是用更少的等待、更少浪费的 token，得到同样有用的结果。

## 为什么选择 miao

### 按任务选择模型，保留熟悉的工作流

在同一个界面连接多个供应商，随时切换会话模型，也可以为专门的代理设置各自的模型和权限。模型目录与自定义供应商配置，让你按推理能力、响应速度或价格做选择，减少切换工具和重新建立上下文的成本。

### 长任务持续推进，中途也能补充要求

代理执行时，你仍然可以提交新要求。V2 会先持久化输入，再调度执行，在安全的模型轮次边界把补充要求带入会话；显式排队的输入则等当前工作即将空闲时再处理。无需另开对话，也不必为每一次工具调用停下来重新交代任务。

### 把专项工作交给拥有独立上下文的代理

通过子代理委派一个范围明确的任务，后续还可以继续同一个子会话。V2 提供 `list_sessions` 和 `send_message`，代理能在权限约束下发现并联系同项目的其他会话。把调研、排查等专项工作放进独立对话，主会话保持对整体目标的关注。

### 看清 token、缓存和费用花在哪里

逐轮用量、估算费用、首 token 延迟和提示缓存遥测，让性能有据可查。Context Epoch 保持一段会话内的系统上下文基线不变，把变化按时间顺序引入，帮助复用缓存前缀。工具输出裁剪、压缩调优、缓存 TTL 和会话预算均可按需配置，为长任务提供更多成本控制手段。

费用按配置的模型费率和供应商货币信息估算，方便理解会话开销；实际扣费以供应商账单为准。

### 工作记录可以继续，也可以检查和复用

V2 使用持久化输入与事件记录保存会话。你可以查看、重新打开、分叉和导出会话，让工作记录不局限于某一个终端窗口。过大的工具输出在模型上下文中受到限制，完整内容在可用时保留到临时文件。

保存历史不代表崩溃后自动续跑：未完成的模型执行需要显式恢复，也不保证任意命令严格只执行一次。

## 面向日常工程工作的能力

| 你要完成的事       | miao 提供的能力                                                           |
| ------------------ | ------------------------------------------------------------------------- |
| 理解陌生仓库       | 文件读取、搜索、项目指令、技能、专项子代理                                |
| 实现功能并验证     | 文件编辑与补丁、Shell 命令、可选 LSP 诊断和格式化                         |
| 比较模型而不换工具 | 会话内模型切换、自定义供应商、按代理配置模型、受支持模型的推理档位        |
| 推进较大的任务     | 待办、中途补充要求、持久化会话、可选自治续跑                              |
| 接入自己的工具     | 本地与远程 MCP、自定义命令、技能、插件                                    |
| 检查并复用工作成果 | 差异查看、会话分叉、历史导出、权限确认                                    |
| 接入其他应用       | HTTP 服务、浏览器界面、CLI 自动化、工作区内生成的 Promise / Effect 客户端 |

**可以从这样一个任务开始：**「找到这个测试失败的原因，修复它，运行相关检查，并解释代码差异。」执行中再补充：「保持公共 API 不变，不引入新的运行时依赖。」

## 快速开始

macOS / Linux 用下面的 bash 脚本安装；Windows 在 PowerShell 里运行：

```powershell
irm https://mtty.dev/miao/install.ps1 | iex   # Windows：PowerShell 5.1 或 7
```

Windows 终端里的显示仍在验证中，见 [Windows 验证说明](docs/windows-vt-verification.zh.md)。

```bash
curl -fsSL https://mtty.dev/miao/install | bash   # 跳转到本仓库的 install 脚本

miao providers login          # 选择供应商，连接账户或 API Key
cd /path/to/project
miao                          # 启动终端界面
```

在 TUI 内用 `ctrl+p` 打开命令面板，或用 `ctrl+x m` 选择模型。`miao models` 可以列出可用模型。

```bash
miao run "解释这个仓库的架构，找出主要入口"
miao web                      # 打开浏览器界面
miao upgrade                  # 更新正式版
```

安装脚本把正式版放到 `~/.miao/bin/miao`。配置、权限、MCP、LSP 和排障说明见 [使用指南](docs/guide.zh.md)。

## 给长任务设置执行边界

V2 自治循环需要显式开启：待办仍未完成时继续推进，同时受迭代次数和停滞检测约束。费用预算达到估算阈值后停止调度后续模型轮次；它不是供应商账单的硬上限，也不会截断正在执行的请求。

```jsonc
{
  "loop": { "enabled": true, "max_iterations": 25 },
  "cost": { "budget_usd": 5 },
  "compaction": { "prune": true },
}
```

项目配置放在 `.miao/miao.jsonc`，全局配置放在 `~/.config/miao/miao.jsonc`。这些设置都是可选的，调优前请查看 [配置参考](docs/guide.zh.md#4-配置参考)。

## 用微信、QQ 遥控会话（实验性）

`miao remote` 在 `127.0.0.1` 上同时运行 miao 服务和已接入的 IM 通道（微信 iLink ClawBot、QQ 机器人），可以在手机上查看会话、新建会话、发 prompt、审批工具调用、中断。只接受扫码登录者本人的消息，只能遥控 `remote.projects` 里列出的目录。

```sh
miao remote login wechat   # 用微信扫码登录
miao remote login qq       # 用手机 QQ 扫码，新建一个专用机器人后点「连接到第三方平台」
miao remote                # 前台运行；桌面上用 miao attach http://127.0.0.1:4097 打开同一批会话
miao remote install        # 写入 launchd 配置，并打印加载它的 launchctl 命令
miao remote status
```

```jsonc
{
  "remote": {
    "port": 4097,
    "projects": { "miao": "~/workspace/code/github/miao" },
    "wechat": { "push_budget_per_day": 4 },
    "qq": { "markdown": true },
  },
}
```

在 TUI 里输入 `/remote`：查看守护进程和已接入的账号，接入新账号（二维码直接画在对话框里），发测试消息、断开。**第一个账号也可以完全在 `/remote` 里完成，不必用 CLI**：守护进程没运行时，选中连接器回车即在本机扫码登录（凭证与守护进程共用 `remote-auth.json`），再选「启动守护进程（launchd 常驻）」或「仅本次启动（后台）」——对话框会先列出将要执行的 `launchctl` 或启动命令，按回车确认后才执行，就绪后自动切到守护进程状态；运行中也可以在这里「停止守护进程」（同样需确认）。它通过 `remote.port` 找守护进程。`miao remote` 没有任何账号时也会照常启动，之后登录的账号立即生效；`miao remote login` 发现守护进程在运行时会通过它登录，不用重启。

在 IM 里发 `/help` 查看命令（`/list`、`/use N`、`/new <项目> [内容]`、`#N 消息`、`/stop`、`/r`、`/status`），审批用 `y7` / `a7` / `n7` 这样的短码回复。微信只允许在你上一条消息之后约两分钟内回复，主动推送也有限流，所以较晚结束的结果会留到你下次发消息（或发 `/r`）时一起回给你。QQ 在你发消息后几分钟内被动回复，之后自动改发主动消息，所以结果能及时送达，除非你在 QQ 里关闭了这个机器人的主动消息。腾讯没有明确允许或禁止第三方 ClawBot 客户端，限制与风险见 [specs/remote-im.md](specs/remote-im.md)。其它 IM 可以作为连接器接入，列在 `remote.connectors` 里。

## 有数据，也有明确边界的性能优化

miao 包含 Rust 加速模块，以及与本仓库早期 TypeScript 实现的对照基准。以下摘自已有的同机实测记录，采用 release 构建与中位数：

| 独立操作                     | TypeScript 基线 | Rust 原生 | 提速  |
| ---------------------------- | --------------- | --------- | ----- |
| edit 模糊匹配，12k 行        | 0.76 ms         | 0.39 ms   | 1.9×  |
| patch Unicode 归一化，20k 行 | 13.06 ms        | 5.21 ms   | 2.5×  |
| git status，10 个文件        | 12.3 ms         | 1.0 ms    | 11.9× |

这些是**组件级基准，不代表整个任务的提速，也不是与当前上游版本的对比**。原生 edit／patch 接入和可选的 macOS / Linux 内核沙箱目前位于兼容工具路径；V2 使用独立工具实现。进程内 Git 仍属原型。完整数据和可用范围见 [对比说明](docs/miao-vs-opencode.zh.md)。

## 当前状态与架构

miao 处于 pre-1.0。终端界面和受支持的浏览器连接默认使用 V2，V1 保留用于兼容。V2 核心采用 Effect 服务、按 Location 限定的工具、持久化输入箱、事件记录与 Context Epoch。执行协调目前限于本进程，尚未实现集群执行和崩溃后自动续跑。

| 能力                                               | 可用状态                                 |
| -------------------------------------------------- | ---------------------------------------- |
| V2 会话、持久化输入、Context Epoch、项目内会话消息 | 已实现                                   |
| 自治续跑、费用预算、输出裁剪与压缩调优             | 按需开启；各设置行为不同                 |
| Code Mode（`MIAO_EXPERIMENTAL_CODE_MODE=1`）       | 实验功能                                 |
| 原生 edit／patch                                   | 兼容运行时；启用方法和限制见对比文档     |
| bash 的 OS 沙箱                                    | V2 与兼容运行时；通过 `sandbox` 配置开启 |
| 生成的客户端与内嵌 Effect host                     | 私有工作区包，API 仍在演进               |

### V1 与 V2 的区别

V1 是 miao 从 opencode 继承的会话运行时，V2 是 miao 重写的新内核。两者共用同一个数据库和配置，但会话的执行方式不同。V1 正在退役，见 [specs/architecture.md](specs/architecture.md)。

| 方面        | V1（继承自 opencode）                                      | V2（miao 内核）                                                          |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| 代码位置    | `packages/miao/src/session` 与旧工具                       | `packages/core`，按 Schema → Core / Protocol → Server 分层               |
| 发送 prompt | 收到即执行                                                 | 先写入持久化输入箱再执行，进程崩溃也不丢                                 |
| 运行中插话  | 先保存，正在运行的循环在下一步读到它；不区分 steer / queue | steer（在下一个安全点并入当前回合）或 queue（等本回合结束再执行）        |
| 回合循环    | 一个大循环包住工具调用                                     | 每个模型回合只调用一次 `llm.stream`，续跑前从存储重新加载历史            |
| 存储        | `message` / `part` 表                                      | 事件日志加投影，每个会话有递增的 `seq`，可从任意位置回放                 |
| 上下文      | 每次请求重新拼装                                           | Context Epoch：稳定基线加按时间追加的更新，缓存前缀保持稳定              |
| API         | 旧的 `/session/*` 路由与旧版 JS SDK                        | 用 Effect Schema 定义的 `/api/session/*`，客户端由 schema 生成           |
| 工具与权限  | 旧工具；bash 权限按子命令前缀匹配                          | 按 Location 限定的工具与权限；bash 支持 OS 沙箱、执行前语法检查、`stdin` |
| 插件        | 支持全部插件钩子                                           | 部分 `chat.*` 钩子尚未调用                                               |
| 费用与缓存  | 基本用量                                                   | 每回合用量与费用、TTFT、缓存命中率与未命中原因、费用预算                 |
| 跨会话协作  | 无                                                         | 子会话（`task`）、`list_sessions` / `send_message`                       |
| 使用方      | 旧版 JS SDK 与 `/session/*` 路由                           | 默认 TUI、`--mini`、ACP、`miao run`、Web 应用、`miao remote`             |

日常用 `miao` 正式版，源码迭代用 `miao-dev`，编译验证用 `miao-preview`。源码中的新能力可能尚未包含在已安装的发行版里。

## 相关项目

| 项目             | 是什么                                                                                                | 链接                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **miao**(本仓库) | 在终端里运行的 AI 编程代理                                                                            | [mtty.dev/miao](https://mtty.dev/zh/miao) · [文档](https://mtty.dev/zh/docs/miao) · [oxdingzg/miao](https://github.com/oxdingzg/miao) |
| **mtty**         | 用 Rust 编写、GPU 渲染的终端(macOS、Linux、Windows),能看出每个窗格里的代理正在工作、在等你,还是已完成 | [mtty.dev/mtty](https://mtty.dev/zh/mtty) · [oxdingzg/miao-term](https://github.com/oxdingzg/miao-term)                               |
| **mtty.dev**     | 两者的官网与文档站                                                                                    | [mtty.dev](https://mtty.dev/zh/)                                                                                                      |

miao 与 mtty 是两个独立项目,任意一个都可以单独使用。在 mtty 的窗格里运行 miao 时,miao 会把自己的状态(工作中、等待你、已完成、出错)上报给 mtty;mtty 据此给窗格加徽章、在代理需要你时通知你,并在它空闲时发出你排队的提示。离开 mtty,上报不产生任何作用。`miaotty` 是这个终端的个人 macOS 原型,已由 mtty 取代。

## 文档与开发

- [使用指南](docs/guide.zh.md) · [Usage guide](docs/guide.en.md)
- [miao 与 opencode 基线对比](docs/miao-vs-opencode.zh.md) —— 测量数据、差异和接入状态
- [发布流程](docs/release.zh.md) —— 版本、构建与发布
- [运行时设计](CONTEXT.md) · [V2 规格](specs/v2) —— 会话、上下文与客户端契约

开发需要 [Bun](https://bun.sh)：

```bash
bun install
bun run dev
# 在修改的包目录内执行检查，例如：
cd packages/miao
bun typecheck
```

miao 是基于 opencode 的 MIT 许可衍生作品，独立开发与发布，与 OpenCode 团队无隶属关系，也未获得其背书。详见 [LICENSE](LICENSE)。
