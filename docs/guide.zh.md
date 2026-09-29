# miao 使用指南

<p align="center"><a href="guide.en.md">English</a> | <a href="guide.zh.md">简体中文</a></p>

> [!NOTE]
> miao 尚处于 pre-1.0、活跃开发中，CLI 与配置可能随版本变化。本指南尽量把「怎么装、怎么用、怎么排障」讲全，降低上手门槛。

## 1. 这是什么

miao 是一个终端里的 AI 编程工具（TUI + HTTP server），由 [opencode](https://github.com/anomalyco/opencode) fork 而来。它不是想做成大而全的产品，而是如实反映作者每天在用、在改的东西，方向固定为三条：

- **更快** —— 最小化启动、首 token 与每轮响应延迟。
- **更广** —— 一套接口适配尽可能多的模型与供应商。
- **更省** —— 同样的结果，花更少时间和 token。

与 opencode 的关系：miao 是衍生作品，MIT 许可，**非 OpenCode 团队开发、无背书、无隶属**。相比 opencode，miao 额外提供内核级沙箱、进程内 git 状态、独立的版本/更新源、成本核算与缓存遥测等（详见 [README.zh.md](../README.zh.md) 与 [miao-vs-opencode.zh.md](miao-vs-opencode.zh.md)）。

## 2. 安装与升级

需要 macOS / Linux（Windows 构建可用但未完整验证）。

```bash
# 安装稳定版
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

# 指定版本
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash -s -- --version 0.0.1

# 从本地二进制安装
./install --binary /path/to/miao
```

安装脚本默认会把二进制放到 `~/.miao/bin/miao` 并写入 PATH；用 `--no-modify-path` 可跳过。

**三个入口（并存，互不干扰）**

| 命令 | 是什么 | 数据/配置 | 更新 |
|---|---|---|---|
| `miao` | 稳定版（官方 release 二进制） | channel `latest`，DB `miao.db` | 后台自动更新 |
| `miao-dev` | 从源码运行，唯一能看到**未提交改动**的入口 | channel `local`，DB `miao-local.db` | 手动 |
| `miao-preview` | 当前 checkout 的编译版（`./script/install-local.sh` 安装） | 当前分支为 channel | 不自动更新 |

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
miao auth login <provider>

# 2. 列出可用模型
miao models

# 3. 在项目目录启动 TUI
cd /path/to/project
miao
```

典型配置（全局 `~/.config/miao/miao.jsonc` 或项目内 `.miao/miao.jsonc`；`.opencode/` 作为读取回退）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5-5",
  "permission": { "*": "allow" },
  "lsp": true,
  "formatter": true
}
```

## 4. 配置参考

配置文件按优先级合并：项目 `.miao/` > 全局 `~/.config/miao/`，另外可用 `MIAO_CONFIG` 指定。主要字段：

| 字段 | 作用 |
|---|---|
| `model` | 默认模型（`provider/model`） |
| `default_agent` | 默认 agent |
| `permission` | 权限规则（`allow` / `ask` / `deny`，可分级按工具/路径）；未匹配默认 `ask` |
| `agents` | 自定义 agent（模型、系统提示、权限、步数上限） |
| `lsp` | 语言服务器：`true` 启用全部内置，`false` 关闭，或按名配置。**省略 = 全部禁用** |
| `formatter` | 代码格式化：`true` 启用内置，或按名配置命令 |
| `mcp` | MCP 服务器（local stdio / remote streamable-http） |
| `compaction` | 压缩行为（`prune` 裁剪旧工具输出、`summarize_small` 用廉价模型摘要、`hot_prefix` 复用热前缀、`precise_tokens` BPE 阈值） |
| `cache` | `ttl_seconds` 延长 prompt cache TTL |
| `cost` | `budget_usd` 每会话成本预算（超限告警并停止续跑） |
| `loop` | 自治续跑（见 §5.8） |
| `shell` | 默认 shell |
| `skills` / `commands` / `instructions` / `references` / `plugins` | 技能、命令、指令、引用、插件 |
| `watcher` / `attachments` / `tool_output` / `snapshots` | 文件监听、附件、工具输出阈值、快照 |
| `providers` | 自定义 provider / 模型（含本币单价 `cost`） |
| `experimental` | 实验开关（如 Code Mode） |

**本币计价**：`providers.<id>.models.<m>.cost` 用 provider 官方本币单价（如 DeepSeek 的 CNY），成本统计与真实账单一致；TUI 内 `/currency` 可切换显示货币（默认 USD，未声明本币的 provider 按静态汇率换算）。

## 5. 日常使用

### 5.1 TUI 快捷键

默认 **leader 键是 `ctrl+x`**，组合执行动作：

| 快捷键 | 动作 |
|---|---|
| `ctrl+p` | 命令面板 |
| `ctrl+x` `b` | 显示/隐藏右侧边栏（子会话不显示） |
| `ctrl+x` `m` | 选择模型 |
| `ctrl+x` `l` | 会话列表 |
| `ctrl+x` `n` | 新建会话 |
| `ctrl+x` `t` | 主题 |
| `ctrl+x` `c` | 压缩会话 |
| `ctrl+x` `g` | 时间线 |
| `ctrl+x` `q` | 退出 |

可在 `~/.config/miao/tui.json`（或 miao.jsonc 的 `keybinds`）里重绑定。

### 5.2 会话与模型

- `/model` 或 `ctrl+x m` 切换模型（会记住每个 agent 上次使用的模型）。
- `miao session list` / `miao export <sessionID>` 管理与会话导出（`--format jsonl` 每行一条消息，便于 grep/备份）。
- `miao run -p "..."` 非交互执行一次。

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
      "remote": { "type": "remote", "url": "https://example.com/mcp" }
    }
  }
}
```

### 5.5 LSP 与格式化

- `lsp: true` 启用后，读/写文件会懒激活语言服务器，编辑后把诊断回灌给模型（`LSP errors detected… please fix`）。
- `formatter: true` 启用后，`edit`/`write`/`apply_patch` 成功后按扩展名跑格式化命令。
- 侧边栏 LSP 一栏显示服务器连接状态；**改配置后需重启 miao 才生效**。

### 5.6 内核级沙箱（opt-in）

```bash
MIAO_SANDBOX=1 miao                       # 写入限制在工作目录（macOS seatbelt / Linux landlock）
MIAO_SANDBOX_DENY_NETWORK=1 MIAO_SANDBOX=1 miao   # 同时禁网
```

被拒的写入会回传并询问后重试。规则式权限做不到这种强制；沙箱由内核兜底。

### 5.7 成本与缓存遥测

每轮 provider turn 记录 TTFT、缓存命中率、`warm` / `expectedRebuild` / `cacheMiss` 与成本；会话汇总、revert 时回滚。侧边栏显示 `% cached` 与已花费。

### 5.8 自治续跑循环（新）

让 agent「一轮又一轮」自己推进到 todo 全部完成：

```jsonc
{ "loop": { "enabled": true, "max_iterations": 25 } }
```

行为：drain 收尾时若会话 todo 仍有未完成项，就自动追加一条续跑提示并继续；**三道护栏**——最大迭代数、成本预算（`cost.budget_usd`）、停滞检测（todo 连续 2 轮不变即停）。模型用 `todowrite` 维护清单，全部 `completed`/`cancelled` 自然结束。

## 6. 规划 / Roadmap

miao 正处在 **V1 → V2 的运行时重建**中（V1 为 opencode 继承实现，V2 是 Effect 原生核心）。

- **终局迁移**（[specs/v2/v1-retirement.zh 设计](https://github.com/oxdingzg/miao/blob/main/specs/v2/v1-retirement.md)）：
  - Stage 1 探测缝 —— 已完成（`/api/health` 自标识）。
  - Stage 2 协议补齐 —— 已完成（`session.todo/children/status/shell/skill/diff/fork/command/rename/archive/remove`）。
  - Stage 3 旧会话可见性 —— 已完成（只读回退 + 可选回填 `miao db backfill`）。
  - Stage 4 分 surface 写翻转、Stage 5 删 V1 —— 未做（改动每日在用引擎，需分阶段验证）。
- **存储加固**（[specs/storage/session-storage-hardening.md](https://github.com/oxdingzg/miao/blob/main/specs/storage/session-storage-hardening.md)）：已完成 `miao db stats`/`vacuum`、`export --jsonl`；事件去快照/附件外置/回收待 V2 落地后迁移。
- 其余未做缺口：崩溃恢复幂等、后台作业、MCP 渐进式发现/OAuth、syscall 级 confinement、权限 fail-closed 强化等。

## 7. 常见问题（FAQ）

**Q：侧边栏 LSP 一直显示 “LSPs are disabled”？**
配置里没写 `lsp`（省略即禁用）。在 `miao.jsonc` 加 `"lsp": true` 并**重启 miao**（当前会话读的是启动时配置）。

**Q：`ctrl+x b` 打不开侧边栏？**
子会话（由 task/subagent 派生、`parent_id` 非空）侧边栏被强制隐藏；顶层会话可用。窄终端（宽度 ≤120）auto 模式也不默认显示，但手动 toggle 有效。

**Q：模型/供应商怎么配？**
`miao auth login <provider>` 写凭据；`miao models` 查看；在 `miao.jsonc` 的 `providers` 里自定义。provider 的具体报错可用 `miao debug` 排查。

**Q：成本显示和账单对不上？**
让 provider 用本币单价（`providers.<id>.models.<m>.cost` 用本币）；或用 `/currency` 切换显示货币。

**Q：native（Rust）路径出问题怎么办？**
`MIAO_NATIVE=0 miao` 回退到纯 TS 的 edit/apply_patch。

**Q：能像 Claude Code 那样一条命令跑一整轮自治吗？**
用 `loop` 配置（§5.8），或外部循环 `miao run -p "...continue..."`。

**Q：会改我的 git 仓库吗？**
快照用独立 git 目录（`~/.local/share/miao/snapshot/…`），不污染工作树；编辑/命令仍需你授权。

## 8. 排障

```bash
miao db path              # 数据库路径
miao db stats             # 表/事件占用（定位膨胀）
miao db vacuum            # checkpoint + VACUUM 回收空闲页
miao db backfill          # 把旧 V1 会话消息转成 V2 投影（幂等、可选）
miao export <sessionID> --format jsonl   # 导出会话
MIAO_CONFIG=/path/miao.jsonc miao        # 指定配置
```

日志位于 `~/.local/share/miao/log/`。数据库膨胀主要来自 V1 遗留的逐 delta 事件；在 V1 完全退役前，`miao db stats` 可监控，`vacuum` 可回收空闲页。

## 9. 开发

```bash
bun install
bun run dev                     # 源码运行（等价 miao-dev）
bun --cwd packages/miao typecheck
bun --cwd packages/miao test
./script/install-local.sh       # 构建并安装 miao-preview
```

## 许可证

MIT，详见 [LICENSE](../LICENSE)。
