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

miao 是 opencode 的 fork，因此下表的基线就是 opencode 的 TS 实现，同机实测（release、中位数），越大越好。

| 项目 | opencode（TS） | miao（Rust native） | 提速 |
|---|---|---|---|
| edit 精确匹配（12k 行） | 0.21 ms | 0.12 ms | 1.7x |
| edit 模糊匹配（12k 行） | 0.76 ms | 0.39 ms | 1.9x |
| edit 匹配 + diff 统计（12k 行） | 2.03 ms | 1.78 ms | 1.14x |
| apply_patch exact（20k 行） | 1.67 ms | 1.28 ms | 1.3x |
| apply_patch trim 匹配（20k 行） | 3.47 ms | 1.76 ms | 2.0x |
| apply_patch unicode 归一化（20k 行） | 13.06 ms | 5.21 ms | 2.5x |
| git status 小仓（10 文件） | 12.3 ms | 1.0 ms | 11.9x |
| git status 大仓（2200 文件） | 13.6 ms | 5.8 ms | 2.4x |

速度之外：

- **内核级沙箱**（macOS seatbelt）：写只限工作目录、默认禁网、被拒路径回传并询问后重试。规则式权限做不到这种强制。
- **gix 进程内 git status**：不再起子进程。
- **独立的版本与更新源**（`oxdingzg/miao`，版本从 `0.0.1` 起）。

状态：原生模块与沙箱是 PoC，尚未接入生产；版本、更新源、品牌已合入。完整对比见 [docs/miao-vs-opencode.zh.md](docs/miao-vs-opencode.zh.md)。

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
