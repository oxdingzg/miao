<p align="center">
  <strong>miao</strong>
</p>
<p align="center">同样的结果，更快、更省。</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

miao 是一个用于日常工程工作的终端 AI 编程代理，fork 自
[opencode](https://github.com/anomalyco/opencode)。它只围绕一个约束来构建：
**用更低的延迟和更少的 token，得到同样的结果。**

大多数编程代理只以能力论高下。miao 把延迟、token 消耗和成本当作运行时的一等属性，而不是事后
加上去的开关。目标是一个启动更快、单轮返回更快、每天都更省钱的代理——同时不牺牲模型覆盖面和
安全性。

## 设计原则

- **延迟是预算。** 启动、首 token、每轮响应延迟都被度量并守住。热路径在进程内执行，不起子进程、
  不付逐次调用的进程开销。
- **token 与费用都要可计量。** 提示缓存稳定性、上下文纪元（Context Epoch）、压缩调优、逐轮成本
  核算都是运行时的一部分，而非外挂。成本按 provider 的本币计量，统计与真实账单一致。
- **广覆盖优先于锁定。** 一套接口适配尽可能多的模型与供应商，并有显式的模型目录。
- **安全是强制的，不是请求式的。** 规则式权限之外，可选的内核级沙箱（macOS seatbelt / Linux
  Landlock）在系统调用层限制写入与网络——这是规则式权限无法保证的。

## 实测性能

基线是本仓库在引入原生模块之前、opencode 的 TypeScript 实现，同机实测（release 构建、中位数）。
越大越好。

| 路径 | opencode（TS） | miao（Rust 原生） | 提速 | 状态 |
|---|---|---|---|---|
| edit 精确匹配（12k 行） | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit 模糊匹配（12k 行） | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit 匹配 + diff 统计（12k 行） | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch exact（20k 行） | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim 匹配（20k 行） | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode 归一化（20k 行） | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status 小仓（10 文件） | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status 大仓（2200 文件） | 13.6 ms | 5.8 ms | **2.4x** | PoC |

- opencode 的 git 状态是子进程模型，10 个文件也要付 ~11 ms 的固定开销；miao 用 `gix` 进程内读取，
  开销随文件数增长。
- 模糊匹配与 unicode 归一化是纯 CPU 路径（2–2.5x）。被整文件 diff 与字符串拼接主导的路径收益较小
  （1.1–1.3x），因为两边都要付同一套 O(n) 成本。

## opencode 之外

| 能力 | 说明 | 状态 |
|---|---|---|
| 内核级沙箱 | 需开启（`MIAO_SANDBOX=1`）：macOS seatbelt / Linux Landlock 把写入限制在工作目录；被拒路径回传并在询问后重试。默认放行网络（`MIAO_SANDBOX_DENY_NETWORK=1` 才禁网） | opt-in |
| 进程内 git status | `gix`，不再起子进程 | PoC |
| 独立的版本与更新源 | `oxdingzg/miao`，版本从 `0.0.1` 起，独立发布与自更新 | 已合入 |
| 成本核算 | 按模型费率计算逐轮成本、会话汇总、revert 时回滚 | 已合入 |
| 按 provider 本币计价 | 使用 provider 官方本币单价（如 DeepSeek 的 CNY），统计与账单一致 | 已合入 |
| 缓存遥测 | 逐轮 TTFT、缓存命中率、warm / expected-rebuild / miss，可配 TTL | 已合入 |
| 压缩调优（opt-in） | 廉价摘要模型、热前缀复用、BPE 阈值、工具输出裁剪 | opt-in |
| 自治循环 | 一直做到 todo 列表完成为止，受迭代次数、成本预算与停滞检测约束 | 实验（V2 runner） |
| Code Mode | 工具集收成一个 `execute` 工具 + budgeted catalog | 实验 |

Rust 原生的 edit / apply_patch 路径默认开启（`MIAO_NATIVE=0` 回退纯 TS）；其余原生模块尚未接入
默认路径。进程沙箱已接入但需开启（`MIAO_SANDBOX=1`）。版本、更新源、品牌与成本相关已合入。完整
对比见 [docs/miao-vs-opencode.zh.md](docs/miao-vs-opencode.zh.md)，接入风险见
[docs/rust-integration-risks.zh.md](docs/rust-integration-risks.zh.md)。

## 架构

miao 正处于 **V1 → V2 运行时重建**的收尾阶段。Effect 原生的 V2 现在已是终端 TUI 与浏览器 app 的
默认运行时；源自 opencode 的 V1 仍挂载以保证兼容，可用 `MIAO_TUI_V2=0`（TUI）或 `?protocol=v1`
（app）强制回退。与延迟和成本相关的机制：

- **Effect 原生核心（Effect v4）。** V2 运行时基于 Effect 构建，显式服务、类型化错误、作用域资源，
  行为是组合出来的，而不是打补丁堆出来的。
- **持久化、事件溯源的会话。** 会话历史是只追加的事件日志，投影到单写入者的读模型，因此重放、
  恢复、跨进程 tail 都是一等能力。
- **Context Epoch（上下文纪元）。** 每个提示缓存基线在其纪元内不可变；会话中途的上下文变化通过安全
  轮次边界上的持久化 system 消息引入，保持提示缓存前缀稳定、廉价。
- **原生加速。** CPU 密集的热路径（edit、apply_patch、进程内 git status）在 Rust 插件中实现，通过
  napi 进程内调用，并保留纯 TS 回退；其中 edit 与 apply_patch 路径默认开启。

V2 运行时的设计说明见 [CONTEXT.md](CONTEXT.md) 与 [specs/v2](specs/v2)；切换计划见
[specs/v2/v1-retirement.md](specs/v2/v1-retirement.md)。

## 安装

需要 macOS / Linux（Windows 构建可用但未完整验证）。

```bash
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

miao auth login <provider>   # 凭证写入 auth.json
cd /path/to/project
miao                         # 启动 TUI
```

升级用 `miao upgrade`；安装脚本会把二进制放到 `~/.miao/bin/miao`。

## 文档

- [使用指南（中文）](docs/guide.zh.md) —— 安装、配置、TUI、MCP/LSP/沙箱、自治循环、FAQ、排障。
- [Guide (English)](docs/guide.en.md) —— the same guide in English.
- [miao vs opencode](docs/miao-vs-opencode.zh.md) —— 完整基准与能力对比。
- [版本管理与发布](docs/release.zh.md) —— 版本方案与发布流程。

## 状态

miao 尚处于 pre-1.0，活跃开发中：CLI 与配置可能随版本变化，V1 运行时仍在退役过程中。日常使用的
稳定命令是 `miao`；`miao-dev` 从源码运行，`miao-preview` 构建当前检出。

## 基于 opencode

miao 是基于 [opencode](https://github.com/anomalyco/opencode) 的衍生作品，采用 MIT 许可证。miao
并非由 OpenCode 团队开发，也未获得其背书，双方不存在隶属关系。

## 开发

需要 [Bun](https://bun.sh)。

```bash
bun install
bun run dev
```

提交改动前，请在包目录（例如 `packages/miao`）内运行 `bun typecheck`。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
