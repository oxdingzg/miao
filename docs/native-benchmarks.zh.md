# 原生组件基准与接入范围

[English](native-benchmarks.en.md)

这些是 miao 原语与本仓库早期 TypeScript 实现的历史测量，不是与其他代理产品的对比。接入范围于 2026-10-07 核对，本轮没有重跑基准。用户工作流差异见[编程代理对比](agent-comparison.zh.md)。

## 已有的原生基准记录

基线是本仓库引入原生模块之前的 TypeScript 实现，不是当前的 `anomalyco/opencode`。数据为同机 release 构建的中位数，测量经 Rust 插件调用的独立操作，不包含双方共有的编排、I/O、LSP、格式化、供应商延迟或模型推理。本次文档更新没有重新运行这些基准；最早承载这些路径的 V1 兼容工具已经删除，但原语本身没有随之消失 —— 只要 addon 已加载（默认即加载），V2 的 edit 与 apply_patch 调用的就是同一套原生匹配与派生。这些数字仍是原语的组件测量，而不是对当前工具的重新基准。

| 操作                                            | TypeScript 基线 | Rust 原生 | 提速      | 接入范围             |
| ----------------------------------------------- | --------------- | --------- | --------- | -------------------- |
| edit 精确匹配（12k 行）                         | 0.21 ms         | 0.12 ms   | **1.7x**  | V2 工具，native 默认 |
| edit 模糊匹配（12k 行）                         | 0.76 ms         | 0.39 ms   | **1.9x**  | V2 工具，native 默认 |
| edit 匹配 + diff 统计（12k 行）                 | 2.03 ms         | 1.78 ms   | 1.14x     | V2 工具，native 默认 |
| apply_patch `deriveNewContents` exact（20k 行） | 1.67 ms         | 1.28 ms   | **1.3x**  | V2 工具，native 默认 |
| apply_patch trim 匹配（20k 行）                 | 3.47 ms         | 1.76 ms   | **2.0x**  | V2 工具，native 默认 |
| apply_patch unicode 归一化（20k 行）            | 13.06 ms        | 5.21 ms   | **2.5x**  | V2 工具，native 默认 |
| git status 小仓（10 文件 / 2 变更）             | 12.3 ms         | 1.0 ms    | **11.9x** | 原型，未接入默认路径 |
| git status 大仓（2200 文件 / 400 变更）         | 13.6 ms         | 5.8 ms    | **2.4x**  | 原型，未接入默认路径 |

匹配和归一化等 CPU 密集操作的收益更明显；进程内 Git 原型减少了子进程启动开销。这些结果都不等于完整编程任务的端到端提速。

## 原生工具与沙箱：适用范围

V2 是唯一的会话运行时，工具位于 `packages/core/src/tool`；V1 兼容工具及其在 `packages/miao/src/tool` 的原生 edit／patch 路径均已删除。

- **edit／patch：** V2 工具经由 `packages/core/src/tool/edit-match.ts` 与 `packages/core/src/patch.ts`，在 addon 已加载（默认即加载）时调用原生 `matchEdit` 与 `deriveNewContentsV2`。`edit-fuzzy.ts` 与 `deriveTs` 是 TypeScript 参考实现，在缺少 addon 或设置了 `MIAO_NATIVE=0` 时启用。匹配与派生是纯计算：文件 IO、权限、条件写入与落盘都留在 Core。
- **OS 沙箱：** V2 `bash` 工具可以把每条命令放进沙箱运行。macOS 用 seatbelt，Linux 用 Landlock，Windows 暂无后端。用 `sandbox.mode: "workspace-write"` 或 `MIAO_SANDBOX=1` 开启，`MIAO_SANDBOX_DENY_NETWORK=1` 禁止网络。默认关闭，需显式开启，且默认 fail-open —— `sandbox.on_unavailable` 默认 `"warn"`，缺少后端的主机会直接裸跑命令，除非设为 `"fail"`。
- **native addon：** 默认启用。它为沙箱 runner、编辑匹配、补丁派生与其他原生辅助提供支持。`MIAO_NATIVE=0` 全部禁用，改由 TypeScript 实现接管。
- **进程内 Git：** 已有 `gix` 实现和基准，尚未成为默认 Git 路径。

依赖沙箱前，请阅读 [使用指南](guide.zh.md#56-内核级沙箱需开启) 与 [接入风险](rust-integration-risks.zh.md)。Windows 内核沙箱尚未实现同等能力。
