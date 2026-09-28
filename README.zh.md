<p align="center">
  <strong>miao</strong>
</p>
<p align="center">同样的结果，更快、更省。</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

miao 是我个人日常使用的 AI 编程工具，基于 [opencode](https://github.com/anomalyco/opencode) fork 而来。一直以来都没能找到特别顺手的工具：总会遇到一些不满意、不方便的地方，而这些改动又没办法在后续升级中持续保留。与其一直绕着它打补丁，不如直接 fork 一份 opencode，把自己日常的修改都放在这里。它没有宏大的目标，只是如实反映我每天在用、在改的东西。

这些调整通常落在三个方向上：

- **更快** —— 最小化启动、首 token 与每轮响应延迟。
- **更广** —— 用一套接口适配尽可能多的模型与供应商。
- **更省** —— 同样的结果，花更少时间和 token。

> [!NOTE]
> miao 目前是私有、预发布项目，尚未开源。

## 与 opencode 的性能与能力对比

miao 是 opencode 的 fork，因此下表的基线就是本仓库 fork 前 opencode 的 TS 实现，同机实测（release、中位数），越大越好。

| 项目 | opencode（TS） | miao（Rust native） | 提速 | 状态 |
|---|---|---|---|---|
| edit 精确匹配（12k 行） | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit 模糊匹配（12k 行） | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit 匹配 + diff 统计（12k 行） | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch exact（20k 行） | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim 匹配（20k 行） | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode 归一化（20k 行） | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status 小仓（10 文件） | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status 大仓（2200 文件） | 13.6 ms | 5.8 ms | **2.4x** | PoC |

- opencode 的 git 状态是子进程模型（10 个文件也要 ~11 ms 的固定开销）；miao 用 `gix` 进程内读取，随文件数增长。
- 模糊匹配与 unicode 归一化是纯 CPU 路径（2–2.5x）；被整文件 diff/字符串拼接主导的路径两边受同一套 O(n) 成本限制（1.1–1.3x）。

速度之外，miao 新增：

| 能力 | 说明 | 状态 |
|---|---|---|
| 内核级沙箱 | 需开启（`MIAO_SANDBOX=1`）：macOS seatbelt / Linux landlock 把写限制在工作目录；被拒路径回传并询问后重试。默认放行网络（`MIAO_SANDBOX_DENY_NETWORK=1` 才禁网）。规则式权限做不到这种强制 | opt-in |
| 进程内 git status | `gix`，不再起子进程 | PoC |
| 独立的版本与更新源 | `oxdingzg/miao`，版本从 `0.0.1` 起，独立发布与自更新 | 已合入 |
| 品牌 | 退出横幅（猫 + MIAO）、终端标题、install 脚本 | 已合入 |
| 成本核算 | 按模型费率算每轮成本、会话汇总、revert 时回滚 | 已合入 |
| 按 provider 本币计价 | 用 provider 官方本币单价（如 DeepSeek 的 CNY），统计与账单一致 | 已合入 |
| 缓存遥测 | 每轮 TTFT、缓存命中率、warm / expected-rebuild / miss，可配 TTL | 已合入 |
| 压缩调优（opt-in） | 廉价摘要模型、热前缀复用、BPE 阈值、工具输出裁剪 | opt-in |
| Code Mode | 工具集收成一个 `execute` 工具 + budgeted catalog | 实验 |

状态：原生模块需开启（`MIAO_NATIVE=1`），未接入默认路径；进程沙箱已接入但需开启（`MIAO_SANDBOX=1`）；版本、更新源、品牌、成本相关已合入。完整对比见 [docs/miao-vs-opencode.zh.md](docs/miao-vs-opencode.zh.md)，接入风险见 [docs/rust-integration-risks.zh.md](docs/rust-integration-risks.zh.md)。

## 基于 opencode

miao 是基于 [opencode](https://github.com/anomalyco/opencode) 的衍生作品，采用 MIT 许可证。miao 并非由 OpenCode 团队开发，也未获得其背书，双方不存在隶属关系。

## 开发

需要 [Bun](https://bun.sh)。

```bash
bun install
bun run dev
```

提交改动前，请在包目录（例如 `packages/miao`）内运行 `bun typecheck`。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
