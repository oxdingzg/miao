<p align="center">
  <strong>Janus</strong>
</p>
<p align="center">最快响应、适配最广模型的入口级 AI 编程工具。</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

Janus 是一个基于 [opencode](https://github.com/anomalyco/opencode) 构建的入口级 AI 编程工具。它围绕三个目标设计：

- **最快响应** —— 最小化启动与首 token 延迟，让入口体验接近即时。
- **适配最广模型** —— 用一套接口适配尽可能多的模型与供应商。
- **入口级** —— 低门槛进入 AI 编程，开箱即用、默认配置合理。

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

提交改动前，请在包目录（例如 `packages/opencode`）内运行 `bun typecheck`。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
