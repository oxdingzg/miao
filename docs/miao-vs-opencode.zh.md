# miao vs opencode：性能与能力对比清单

**语言 / Language:** [中文](miao-vs-opencode.zh.md) | [English](miao-vs-opencode.en.md)

miao 是 opencode 的 fork。opencode 的 TS 实现就是本仓库改原生模块之前的基线，同一套 JavaScriptCore 运行时。本页把已做过的基准与能力对比汇总成一张清单。

测量条件：release 构建、同机、取中位数；TS 基线为 `packages/miao` 现有实现（源码与 `--compile` 产物已实测一致）；Rust 为 `crates/miao-native` 经 napi 进程内调用。结果正确性由 parity 测试保证（29 个 JS + 24 个 Rust）。

## 一、性能对比（越大越好，`x` 为提速倍数）

| 项目 | opencode（TS 基线） | miao（Rust native） | 提速 | 状态 |
|---|---|---|---|---|
| edit 精确匹配（12k 行） | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit 模糊匹配（12k 行） | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit 匹配 + diff 统计（12k 行） | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch `deriveNewContents` exact（20k 行） | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim 匹配（20k 行） | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode 归一化（20k 行） | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status 小仓（10 文件 / 2 变更） | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status 大仓（2200 文件 / 400 变更） | 13.6 ms | 5.8 ms | **2.4x** | PoC |

关键点：

- **opencode 的 git 状态是子进程模型**，固定开销 ~11 ms 起步（10 个文件也要 11 ms）；miao 用 `gix` 进程内读取，随文件数增长，小仓快 12x、大仓仍 2.4x。
- **模糊匹配与 unicode 归一化**是纯 CPU 密集路径，miao 快 2–2.5x；精确匹配快 1.7x。
- 只有被整文件 diff/字符串拼接主导的路径提升较小（1.1–1.3x），因为两边都受同一套 O(n) 组装成本限制。

## 二、能力对比（opencode 没有的能力）

| 能力 | opencode | miao | 状态 |
|---|---|---|---|
| 进程级沙箱 | 无。规则式权限，用户批准后进程拥有完整用户权限 | 需开启（`MIAO_SANDBOX=1`）：macOS seatbelt / Linux landlock 内核级强制写白名单；被拒路径回传并询问后重试。默认放行网络（`MIAO_SANDBOX_DENY_NETWORK=1` 禁网） | opt-in |
| 沙箱可配置 | 无 | `--allow-path` 精确补白名单；`--compat` 兼容模式（只禁凭证路径 + 网络） | opt-in |
| git 状态读取 | `git` 子进程（`diff-files` + `ls-files`） | `gix` 进程内，无 spawn | PoC |
| 自更新源 | `anomalyco/opencode`，跟随 upstream 版本号 | `oxdingzg/miao`，版本从 `0.0.1` 起，不跟随 upstream | 已合入 |
| 品牌 | opencode | miao：退出横幅（猫 + MIAO）、终端标题以 miao 开头、install 脚本 | 已合入 |

沙箱实测（同机）：

| 行为 | opencode（规则式权限） | miao（seatbelt） |
|---|---|---|
| 写 `$HOME/...` | 允许（批准后无强制） | 拒绝（Operation not permitted） |
| 访问网络 | 允许（HTTP 200） | 拒绝（curl exit 6，无法解析主机） |
| 写工作目录 | 允许 | 允许 |
| 普通命令（`git status`） | 正常 | 正常 |

注：上表是沙箱后端（`miao-run` / `__sandbox-run`）的默认行为；接入 shell 工具后默认放行网络，只有 `MIAO_SANDBOX_DENY_NETWORK=1` 才按上表禁网。

## 三、状态与边界（务必看清）

- **已合入 main**：版本与更新源解耦、品牌 rebrand（横幅 / 终端标题 / install 脚本）。
- **native 模块 PoC、已接入处默认开启**：`crates/miao-native` 的 edit/patch 纯函数默认启用（`MIAO_NATIVE=0` 回退）；git/text/walk/shell 模块尚未接入，默认路径仍走 TS 实现、子进程 git、规则式权限。
- **沙箱已接入、需开启**：shell 工具在 `MIAO_SANDBOX=1` 时经沙箱 runner 执行（release 二进制自执行 `__sandbox-run`；macOS seatbelt / Linux landlock）。
- 对比对象是**本仓库 fork 前的 TS 实现**（即 opencode 的实现）；不是 opencode 仓库的实时版本。
- 性能数字是**纯函数隔离对比**，不含 Effect/IO/LSP/格式化等两侧相同的开销。
- 沙箱后端：macOS 与 Linux 已实现；Windows（AppContainer + Job object）尚未实现。

把上述 PoC 接入生产的风险（打包分发、CI 假绿、同步阻塞、平台等）见 [rust-integration-risks.zh.md](rust-integration-risks.zh.md)。

## 四、下一步（进入"已合入"的路径）

1. 把 `edit` / `apply_patch` / `snapshot` 接 native（带 TS 回退），并做 RSS 内存对比。
2. ~~把 bash 工具经 `runSandboxed` 执行~~ 已完成：shell 工具在 `MIAO_SANDBOX=1` 时经沙箱 runner 执行。
3. ~~补 Linux landlock/seccomp 后端~~ 已完成（landlock + TCP 默认禁）。剩 Windows。
