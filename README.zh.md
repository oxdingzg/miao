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
