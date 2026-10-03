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

miao 把重点放在模型周围的工程能力上：**上下文效率、持久化会话、代理协作，以及长任务的执行控制。** 目标是用更少的等待、更少浪费的 token，得到同样有用的结果。

## 看看实际界面

![当前 miao 终端界面：行内编辑 diff、回复和上下文遥测](docs/images/miao.png?v=20261004)

终端与浏览器使用同一个**示例会话**，导入真实应用展示，没有为采集调用模型。采集于 2026-10-04，使用 miao v0.1.0；可选的 mini 界面来自当前 v0.1.1 开发构建，使用内置演示模式。

| 选择模型供应商 | 在浏览器里审阅 |
| --- | --- |
| ![打开供应商选择器，浏览可用服务](docs/images/miao-providers.gif?v=20261004) | ![浏览器工作区：展开代码 diff，并准备后续提示](docs/images/miao-web.png?v=20261004) |

| 紧凑交互模式 · 开发预览 | 允许编辑前先看 diff · 开发预览 |
| --- | --- |
| ![mini 演示：任务进度、编辑 diff 和多选问题](docs/images/miao-mini.gif?v=20261004) | ![mini 编辑权限确认：diff，以及单次允许、始终允许和拒绝选项](docs/images/miao-permission.png?v=20261004) |

更多可暂停的短演示：**[mtty.dev 上的 miao](https://mtty.dev/zh/miao#screens)**。

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

目前 Windows 二进制尚未签名。

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

这些是**组件级基准，不代表整个任务的提速，也不是与当前上游版本的对比**。表中 edit／patch 加速属于已被删除的 V1 兼容工具；V2 的 edit／patch 是 TypeScript 实现。Rust addon 目前仍为可选的 OS 沙箱 runner 提供支持，进程内 Git 仍属原型。完整数据和可用范围见 [对比说明](docs/miao-vs-opencode.zh.md)。

## 当前状态与架构

miao 处于 pre-1.0。V1 会话运行时及其旧 `/session/*` 路由已删除，所有已发布客户端都运行单一 V2 内核。V2 采用 Effect 服务、按 Location 限定的工具、持久化输入箱、事件记录与 Context Epoch。执行协调目前限于本进程，尚未实现集群执行和崩溃后自动续跑。

| 能力                                                       | 可用状态                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| V2 会话、持久化输入、Context Epoch、项目内会话消息         | 已实现                                                         |
| 自治续跑、费用预算、输出裁剪与压缩调优                     | 按需开启；各设置行为不同                                       |
| Code Mode（`MIAO_EXPERIMENTAL_CODE_MODE=1`）               | 实验功能                                                       |
| bash 的 OS 沙箱                                            | V2；通过 `sandbox` 配置或 `MIAO_SANDBOX=1` 开启（macOS/Linux） |
| 旧库数据迁移（`miao db backfill` / `compact` / `restore`） | 为 V2 之前的数据库保留                                         |
| 生成的客户端与内嵌 Effect host                             | 私有工作区包，API 仍在演进                                     |

### 从 V1 到 V2

V1 是 miao 从 opencode 继承的会话运行时，V2 是 miao 重写的新内核。V1 会话运行时、旧工具，以及 `/session/*`、`/permission/*`、`/question/*`、`/sync/*` 路由均已删除，所有已发布客户端都运行 V2。仍保留两处兼容面：读取 V2 之前历史的数据库迁移层，以及仍在迁移到 `/api/*` 的非会话旧路由。

| 关注点                                         | 状态                                            |
| ---------------------------------------------- | ----------------------------------------------- |
| 会话执行、工具、权限                           | 仅 V2                                           |
| `/session/*` 路由与 JS SDK 的旧会话方法        | 服务端不再提供                                  |
| 旧的 `message` / `part` 表                     | `miao db backfill` 读取；`miao db compact` 删除 |
| 可移植的导出与导入（`miao export` / `import`） | 保留                                            |
| 旧形状配置                                     | V2 配置加载器仍可读取                           |
| 非会话旧路由（`/config`、`/mcp`、`/lsp` 等）   | 仍在提供；正在迁移到 `/api/*`                   |

见 [specs/v2/v1-retirement.md](specs/v2/v1-retirement.md) 与 [specs/architecture.md](specs/architecture.md)。

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

miao 采用 MIT 许可证。详见 [LICENSE](LICENSE)。
