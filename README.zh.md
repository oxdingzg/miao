<p align="center">
  <strong>Janus</strong>
</p>
<p align="center">同样的结果，更快、更省。</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

Janus 是一个基于 [opencode](https://github.com/anomalyco/opencode) 构建的入口级 AI 编程工具。目标很简单：**用更少的时间与成本，完成与其他 AI 编程 agent 相同的任务。** 它围绕三个方向设计：

- **更快** —— 最小化启动、首 token 与每轮响应延迟。
- **更广** —— 用一套接口适配尽可能多的模型与供应商。
- **更省** —— 同样的结果，花更少时间和 token。

> [!NOTE]
> Janus 目前是私有、预发布项目，尚未开源。

## 基于 opencode

Janus 是基于 [opencode](https://github.com/anomalyco/opencode) 的衍生作品，opencode 采用 MIT 许可证。Janus 并非由 OpenCode 团队开发，也未获得其背书，双方不存在隶属关系。

## 开发

需要 [Bun](https://bun.sh)。

```bash
bun install
bun run dev
```

提交改动前，请在包目录（例如 `packages/miao`）内运行 `bun typecheck`。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
