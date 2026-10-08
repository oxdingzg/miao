# miao 使用指南

<p align="center"><a href="guide.en.md">English</a> | <a href="guide.zh.md">简体中文</a></p>

> [!NOTE]
> miao 尚处于 pre-1.0、活跃开发中，CLI 与配置可能随版本变化。本指南尽量把「怎么装、怎么用、怎么排障」讲全，降低上手门槛。

## 1. miao 能帮你完成什么

miao 是一个开源编程代理，提供终端界面、HTTP 服务与浏览器界面。它把重点放在模型调用周围的工作上：持久化会话、上下文效率、代理协作和可观察的成本。

用它理解仓库、实现改动、排查测试失败，或委派专项调研。连接你偏好的供应商，配置项目工具，并在任务变化时继续补充要求。miao 支持模型选择与 MCP；miao 的运行时建设与可用范围见 [产品概览](../README.zh.md) 和 [工作流对比](agent-comparison.zh.md)。

第一次可以这样提需求：「找到这个错误的原因，做出适当的最小修复，运行相关检查，再解释代码差异。」执行过程中继续补充约束，无需另开对话。

miao 采用 MIT 许可证。本指南描述当前源码，已安装的发行版可能尚未包含部分更新。

## 2. 安装与升级

支持 macOS、Linux 和 Windows。Windows 安装脚本由 CI 验证；Windows 终端里的显示仍在验证中。

```bash
# 安装稳定版
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

# 指定版本
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash -s -- --version 0.0.1

# 从本地二进制安装
./install --binary /path/to/miao
```

Windows 用 PowerShell 安装脚本（Windows PowerShell 5.1 或 PowerShell 7），装到 `~\.miao\bin` 并加入用户 PATH：

```powershell
irm https://raw.githubusercontent.com/oxdingzg/miao/main/install.ps1 | iex

# 指定版本
$env:MIAO_VERSION = "0.0.33"; irm https://raw.githubusercontent.com/oxdingzg/miao/main/install.ps1 | iex
```

安装脚本默认会把二进制放到 `~/.miao/bin/miao` 并写入 PATH；用 `--no-modify-path` 可跳过。

当前 Windows 版本没有 Authenticode 签名。发布包是 `miao-windows-x64.zip`（较旧的 CPU 可用 `miao-windows-x64-baseline.zip`），内含 `miao.exe`；也可以从 [miao GitHub Releases](https://github.com/oxdingzg/miao/releases) 手动下载解压。安装脚本本身通常不会触发提示，但直接启动下载得到的 `miao.exe` 可能出现 SmartScreen 的“Windows 已保护你的电脑”对话框。出现时按[共用的 Windows 安全提示说明](https://mtty.dev/zh/docs/about/windows-downloads/)处理；杀毒软件报出威胁时不要放行。

**三个入口（并存，互不干扰）**

| 命令           | 是什么                                                                                     | 数据/配置                           | 更新         |
| -------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- | ------------ |
| `miao`         | 稳定版（官方 release 二进制）                                                              | channel `latest`，DB `miao.db`      | 后台自动更新 |
| `miao-dev`     | 从源码运行，唯一能看到**未提交改动**的入口                                                 | channel `local`，DB `miao-local.db` | 手动         |
| `miao-preview` | 当前 checkout 的编译版（`./script/install-local.sh --binary /path/to/prebuilt/miao` 安装） | 当前分支为 channel                  | 不自动更新   |

`auth.json`、配置、快照在各入口间共享，凭证无需重复登录。

**升级 / 卸载**

```bash
miao upgrade            # 升级稳定版
miao uninstall          # 卸载
MIAO_DISABLE_AUTOUPDATE=1 miao   # 本次关闭自动更新
```

## 3. 快速开始

```bash
# 1. 登录 / 配置 provider（凭据写入 auth.json）
miao providers login

# 2. 列出可用模型
miao models

# 3. 在项目目录启动 TUI
cd /path/to/project
miao
```

将 `<provider>/<model>` 替换成 `miao models` 中的条目。典型配置（全局 `~/.config/miao/miao.jsonc` 或项目内 `.miao/miao.jsonc`；`.opencode/` 作为读取回退）：

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "model": "<provider>/<model>",
  "permission": { "*": "ask" },
  "lsp": true,
  "formatter": true,
}
```

## 4. 配置参考

配置文件按优先级合并：项目 `.miao/` > 全局 `~/.config/miao/`，另外可用 `MIAO_CONFIG` 指定。主要字段：

| 字段                                                              | 作用                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model`                                                           | 默认模型（`provider/model`）                                                                                            |
| `default_agent`                                                   | 默认 agent                                                                                                              |
| `permission`                                                      | 权限规则（`allow` / `ask` / `deny`，可分级按工具/路径）；未匹配默认 `ask`                                               |
| `agents`                                                          | 自定义 agent（模型、系统提示、权限、步数上限）                                                                          |
| `lsp`                                                             | 语言服务器：`true` 启用全部内置，`false` 关闭，或按名配置。**省略 = 全部禁用**                                          |
| `formatter`                                                       | 代码格式化：`true` 启用内置，或按名配置命令                                                                             |
| `mcp`                                                             | MCP 服务器（local stdio / remote streamable-http）                                                                      |
| `compaction`                                                      | 压缩（`prune` 裁剪旧输出、`threshold` 触发比例、`summarize_small` 廉价摘要、`hot_prefix` 热前缀、`precise_tokens` BPE） |
| `cache`                                                           | `ttl_seconds` 延长 prompt cache TTL                                                                                     |
| `cost`                                                            | `budget_usd` 每会话成本预算（超限告警并停止续跑）                                                                       |
| `loop`                                                            | 自治续跑（见 §5.8）                                                                                                     |
| `shell`                                                           | 默认 shell                                                                                                              |
| `skills` / `commands` / `instructions` / `references` / `plugins` | 技能、命令、指令、引用、插件                                                                                            |
| `watcher` / `attachments` / `tool_output` / `snapshots`           | 文件监听、附件、工具输出阈值、快照                                                                                      |
| `providers`                                                       | 自定义 provider / 模型（含本币单价 `cost`）                                                                             |
| `experimental`                                                    | 实验开关（如 Code Mode）                                                                                                |

**本币计价**：`providers.<id>.models.<m>.cost` 用 provider 官方本币单价（如 DeepSeek 的 CNY），成本按配置费率估算；TUI 内 `/currency` 可切换显示货币（默认 USD，未声明本币的 provider 按静态汇率换算）。

## 5. 日常使用

### 5.1 TUI 快捷键

默认 **leader 键是 `ctrl+x`**，组合执行动作：

| 快捷键       | 动作                              |
| ------------ | --------------------------------- |
| `ctrl+p`     | 命令面板                          |
| `ctrl+x` `b` | 显示/隐藏右侧边栏（子会话不显示） |
| `ctrl+x` `m` | 选择模型                          |
| `ctrl+x` `l` | 会话列表                          |
| `ctrl+x` `n` | 新建会话                          |
| `ctrl+x` `t` | 主题                              |
| `ctrl+x` `c` | 压缩会话                          |
| `ctrl+x` `g` | 时间线                            |
| `ctrl+x` `q` | 退出                              |

可在 `~/.config/miao/tui.json`（或 miao.jsonc 的 `keybinds`）里重绑定。

### 5.2 会话与模型

- `/model` 或 `ctrl+x m` 切换模型（会记住每个 agent 上次使用的模型）。
- `miao session list` / `miao export <sessionID>` 管理与会话导出（`--format jsonl` 每行一条消息，便于 grep/备份）。
- `miao run "..."` 非交互执行一次。

### 5.3 命令与技能

- 斜杠命令：在 prompt 输入 `/` 触发；命令来自 `commands` 配置。
- 技能（skills）：按描述匹配，模型可用 `skill` 工具加载技能内容。
- `miao agent create` 生成自定义 agent。

### 5.4 MCP

在 `mcp.servers` 配置本地或远程服务器，其工具会以 `mcp__<server>__<tool>` 暴露给模型：

```jsonc
{
  "mcp": {
    "servers": {
      "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
      "remote": { "type": "remote", "url": "https://example.com/mcp" },
    },
  },
}
```

### 5.5 LSP 与格式化

- `lsp: true` 启用后，读/写文件会懒激活语言服务器，编辑后把诊断回灌给模型（`LSP errors detected… please fix`）。
- `formatter: true` 启用后，`edit`/`write`/`apply_patch` 成功后按扩展名跑格式化命令。
- 侧边栏 LSP 一栏显示服务器连接状态；**改配置后需重启 miao 才生效**。

### 5.6 内核级沙箱（需开启）

V2 `bash` 工具可以把每条命令放进 OS 沙箱运行：macOS 用 seatbelt，Linux 用 Landlock，Windows 暂无后端。可在配置中开启：

```jsonc
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

`MIAO_SANDBOX=1`、`MIAO_SANDBOX_DENY_NETWORK=1` 可覆盖配置。`workspace-write` 不限制读取，只允许写入当前 Location、命令工作目录、临时目录、`writable_roots`，以及被拦截后你批准的路径（命令会带该目录重跑）。网络默认允许，可显式禁止。沙箱已开启但主机没有后端时，`on_unavailable` 默认 `"warn"`，命令不带沙箱运行；设为 `"fail"` 则直接拒绝。平台限制见 [接入说明](native-benchmarks.zh.md#原生工具与沙箱适用范围)。

### 5.7 成本与缓存遥测

每轮 provider turn 记录 TTFT、缓存命中率、`warm` / `expectedRebuild` / `cacheMiss` 与成本；会话汇总。成本按模型费率估算，不等于供应商账单；侧边栏显示 `% cached` 与估算花费。

### 5.8 自治续跑循环（新）

让 agent「一轮又一轮」自己推进到 todo 全部完成：

```jsonc
{ "loop": { "enabled": true, "max_iterations": 25 } }
```

行为：drain 收尾时若会话 todo 仍有未完成项，就自动追加一条续跑提示并继续；**三道护栏**——最大迭代数、成本预算（`cost.budget_usd`）、停滞检测（todo 连续 2 轮不变即停）。模型用 `todowrite` 维护清单，全部 `completed`/`cancelled` 自然结束。

### 5.9 中途补充要求，保留完整会话

V2 在调度执行前先持久化输入。当前任务仍需继续时，执行中收到的 steer 输入在安全模型轮次边界生效；显式 `queue` 输入则等会话即将空闲时处理。两者语义不同，都不等于立即打断。普通 TUI 提交使用 steer。

例如先要求修复错误，再补充「保持公共 API 不变，并运行包内测试」。待处理输入会展示尚未进入模型历史的要求。公共 V2 API 还提供 queue 投递和 `resume: false`，后者只保存输入、不启动执行。

通过会话列表重新打开任务，或用 `miao export <sessionID> --format jsonl` 导出记录。历史可以跨终端生命周期保留，但崩溃不会自动重试未完成的模型执行。恢复时先检查已完成的改动；重复执行具有外部副作用的命令前，需要核实之前的执行结果。

### 5.10 专项子代理与项目内会话消息

可以要求代理把范围明确的工作交给专项子代理，例如找出一个 API 的所有调用点，或审查数据库迁移。`task` 返回可通过会话 ID 继续的子会话，独立对话让主上下文不必装下全部调查细节。

V2 `list_sessions` 可发现同项目会话，`send_message` 接受会话 ID 或 `@slug`。消息带发送方标识，持久化进入目标收件箱，并受 `message` 权限和输入队列限额约束。默认 `delivery: "steer"` 在下一个安全轮次边界采纳；显式 `delivery: "queue"` 等会话即将空闲时再处理。跨项目目标会被拒绝。执行仍是进程内的；持久化输入可以送达由另一个本地活动窗口持有的会话，但不提供跨机器执行或自动恢复。

### 5.11 按任务调整上下文与成本

```jsonc
{
  "loop": { "enabled": true, "max_iterations": 25 },
  "cost": { "budget_usd": 5 },
  "compaction": { "prune": true },
  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },
}
```

这组可选配置组合了待办续跑、调度预算、旧输出裁剪和逐工具的模型可见输出限额。预算不会中断正在执行的轮次，也不是账单硬上限。完整输出文件是临时的，受限的会话记录才是持久化历史。工具结果裁剪（微压缩）默认开启，可用 `"prune": false` 关闭。自动压缩默认在上下文达到窗口的 `threshold`（默认 `0.9`）时触发，并依据供应商回报的真实 prompt tokens 判断，因此会在窗口填满前提前压缩，而不是等到最后。廉价模型摘要与热前缀压缩可以单独开启，先确认它们适合当前供应商和任务。

被压缩出模型窗口的原文仍然持久化在磁盘上。`recall` 工具按关键词检索这段历史，让 agent 找回被摘要丢掉的细节，而不必重新读文件或重复已完成的工作。

## 6. 运行时状态与后续工作

所有已发布客户端都使用单一 V2 会话运行时；V1 会话运行时及其 `/session/*` 路由已删除。

- [V1 退役计划](../specs/v2/v1-retirement.md) 记录了删除过程和剩余兼容面（数据库迁移与非会话旧路由）。
- [会话存储设计](../specs/storage/session-storage-hardening.md) 记录存储方案。可用 `miao db stats`、`miao db vacuum` 和 JSONL 导出检查、维护本地记录。
- [代理并发](../specs/v2/agent-concurrency.md) 设计非阻塞子代理与完成即唤醒，避免长任务卡住会话。
- 崩溃后自动执行恢复与集群所有权尚未实现。OS 沙箱已内置于 V2 `bash` 工具但仍需开启，见 [原生组件与沙箱范围](native-benchmarks.zh.md)。

## 7. 常见问题（FAQ）

**Q：侧边栏 LSP 一直显示 “LSPs are disabled”？**
配置里没写 `lsp`（省略即禁用）。在 `miao.jsonc` 加 `"lsp": true` 并**重启 miao**（当前会话读的是启动时配置）。

**Q：`ctrl+x b` 打不开侧边栏？**
子会话（由 task/subagent 派生、`parent_id` 非空）侧边栏被强制隐藏；顶层会话可用。窄终端（宽度 ≤120）auto 模式也不默认显示，但手动 toggle 有效。

**Q：模型/供应商怎么配？**
`miao providers login` 写凭据；`miao models` 查看；在 `miao.jsonc` 的 `providers` 里自定义。可用 `miao debug config` 查看生效配置，用 `miao debug info` 查看安装与插件信息；`miao debug` 列出子命令。

**Q：怎么用我的 Command Code 订阅？**
用 `miao auth login commandcode`（浏览器辅助登录）连一次，或把 `CMD_API_KEY` 设成
[commandcode.ai Studio](https://commandcode.ai/studio/) 生成的 API key。连接后会自动从你的账号
发现可用模型。Command Code 走的是 CLI 订阅端点而非其文档中的 Provider API，因此模型能力与价格
在目录补充前取保守值。

**Q：成本显示和账单对不上？**
让 provider 用本币单价（`providers.<id>.models.<m>.cost` 用本币）；或用 `/currency` 切换显示货币。

**Q：native（Rust）addon 出问题怎么办？**
用 `MIAO_NATIVE=0` 禁用它，编辑匹配与补丁派生随即改由 TypeScript 实现接管。addon 同时用于 OS 沙箱 runner。详见[原生组件范围](native-benchmarks.zh.md)。

**Q：能持续推进一个有多个待办的任务吗？**
用 `loop` 配置（§5.8），或外部循环 `miao run --continue "...continue..."`。

**Q：会改我的 git 仓库吗？**
快照用独立 git 目录（`~/.local/share/miao/snapshot/…`），不污染工作树；编辑与命令遵循配置的权限规则。

## 8. 排障

```bash
miao db path              # 数据库路径
miao db stats             # 表/事件占用（定位膨胀）
miao db vacuum            # checkpoint + VACUUM 回收空闲页
miao db backfill          # 把旧 V1 会话消息转成 V2 结构（幂等）
miao db compact           # backfill 后：删除已退役的 message/part 表及其事件
miao export <sessionID> --format jsonl   # 导出会话
MIAO_CONFIG=/path/miao.jsonc miao        # 指定配置
```

日志位于 `~/.local/share/miao/log/`。V2 之前的数据库膨胀主要来自遗留的逐 delta 事件；`miao db stats` 可监控，`miao db compact` 可退役旧表，`vacuum` 可回收空闲页。

## 9. 开发

```bash
bun install
bun run dev                     # 源码运行（等价 miao-dev）
bun --cwd packages/miao typecheck
bun --cwd packages/miao test
./script/install-local.sh --binary /path/to/prebuilt/miao  # 安装构建机产物
```

## 许可证

MIT，详见 [LICENSE](../LICENSE) 与[项目来源与许可](attribution.zh.md)。
