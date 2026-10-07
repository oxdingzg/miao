# 供应商与模型

[English](providers.en.md)

miao 自带模型层，但不自带模型本身：你连接自己已经在用的供应商，在会话内切换模型，并给不同的 agent 配不同的模型。它在本机运行，无需 miao 或 OpenCode 账号——凭证直接交给供应商。

## 连接供应商

```bash
miao providers login     # 选择供应商，再用 OAuth 或 API key
miao providers list      # 已连接了什么
miao providers logout    # 移除保存的凭证
```

`miao auth login <provider>` 是同一条命令。不带名字的 `miao providers login` 会列出你的构建所知的供应商并提示选择；带名字则直接进入该供应商（例如 `miao auth login commandcode`）。凭证写入 `auth.json`，在 `miao` / `miao-dev` / `miao-preview` 几个入口之间共享，所以只需登录一次。

有些供应商走 OAuth（终端打印网址或打开浏览器，然后等待回调），另一些接受 API key。环境变量里已有 key 的供应商无需 `login` 也会被识别。

## 列出与选择模型

```bash
miao models                     # 你的构建所知的全部 provider/model
miao models anthropic           # 只看某个供应商
miao models --verbose           # 带上成本等元数据
miao models --refresh           # 先从 mtty.dev 刷新目录
```

在 TUI 里，`/model` 或 `ctrl+x m` 切换模型；每个 agent 上次使用的模型会被记住。没有选定模型的会话使用 `model` 设置，写作 `<provider>/<model>`：

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "model": "anthropic/claude-sonnet-4-5",
}
```

专业 agent 可以自带模型和权限；见[使用指南](guide.zh.md#4-配置参考)。

## 目录从哪来

模型元数据（名称、上下文上限、能力、价格）来自 miao 自己在 `mtty.dev` 提供的目录：以公开的 [models.dev](https://models.dev) 目录为基础，在站点部署时合入 models.dev 尚未收录、由 miao 维护的供应商——目前是 [Command Code](https://commandcode.ai)。miao 运行时只读这一个源，没有 models.dev 回退。构建内打包了一份快照，因此离线也能启动。

也可以把它指向别的来源：

| 环境变量 | 作用 |
|---|---|
| `MIAO_MODELS_URL` | 从另一个 URL 拉取目录 |
| `MIAO_MODELS_PATH` | 使用指定的本地目录文件 |

[Command Code](https://commandcode.ai) 是订阅制供应商：用 `miao auth login commandcode`（浏览器辅助）连接，或设置 `CMD_API_KEY`；连接后会从你的账号发现其模型。OpenCode Zen / Go 仍作为可选的第三方供应商保留。

## 自定义供应商

`miao.jsonc` 里的 `providers` 记录可以新增或覆盖供应商：凭证、通信协议（`api`）、额外的请求头或 body、模型列表，以及以原生货币计的成本。

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "providers": {
    "my-gateway": {
      "name": "My gateway",
      "env": ["MY_GATEWAY_API_KEY"],
      "currency": "USD",
      "models": {
        "llama-3.3-70b": {
          "name": "Llama 3.3 70B",
          "cost": { "input": 0.2, "output": 0.6 },
          "limit": { "context": 131072 },
        },
      },
    },
  },
}
```

`env` 指定供应商从哪些环境变量读取 key；`disabled` 会在即使存在凭证的情况下隐藏该供应商及其模型。`api` 选择通信协议，整个文件由 `$schema` 校验。改动后运行 `miao models` 确认该供应商现在报告的内容。

## 成本与货币

每个供应商轮次都会记录用量、首 token 时间、缓存命中情况和估算成本；会话总计显示在侧边栏。成本是按模型标价的估算——以供应商的账单为准。

价格可用供应商自己的货币声明（例如 DeepSeek 用 CNY）。TUI 里 `/currency` 切换显示货币；未声明货币的条目按静态汇率折算为美元。

## 供应商策略（实验性）

`experimental.policies` 列表即使在供应商已配置且已鉴权时也能拒绝其使用。规则按顺序匹配，**最后一条匹配者生效**；当前支持的 `action` 是 `provider.use`，`resource` 支持通配符：

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny",  "action": "provider.use", "resource": "company-*" },
      { "effect": "allow", "action": "provider.use", "resource": "company-eu" },
    ],
  },
}
```

## 排障

- `miao debug config` 查看生效配置，`miao debug info` 查看安装与插件信息；`miao debug` 列出可用子命令。
- 鉴权错误会指出修复方式，通常是 `miao auth login <provider>`；保存的 token 过期时重跑 `miao providers login`。
- 供应商不显示任何模型，通常是缺凭证或被策略禁用；`miao models <provider> --verbose` 会显示解析结果。

配置优先级见[使用指南](guide.zh.md)，供应商层的演进见[开源代理对比](agent-comparison.zh.md)。
