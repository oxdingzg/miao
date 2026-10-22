# 原生引擎的供应商路由

[English](native-provider-routes.en.md)

放到原生（Rust）引擎上的会话通过一份**可信宿主路由清单**访问模型。清单由产品根据模型目录和已连接账号生成；它不是工作区配置，模型可写的文件永远不能提供它。本文记录清单支持的表面、产品如何把目录中的一个模型映射到清单，以及哪些能力明确留在 TypeScript 侧。

清单只携带凭证**引用**。引擎不会通过控制命令收到 token，不会写凭证库，也不会自行刷新凭证；刷新始终属于产品 broker 或独立的 credential daemon。

## 产品如何选择 transport

产品为每个目录模型和账号连接生成一条路由。无法映射的模型不会出现在清单里，因此没有选中它的会话继续由 TypeScript 运行。原生会话一旦选中不可用的模型，会以 `engine_routes_unsupported` 失败，而不是静默回退。

| 产品供应商 / `api.package`                                                | 原生 transport                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@ai-sdk/anthropic`                                                       | `anthropic`（`/v1/messages`）                                       |
| `@ai-sdk/openai`，API key                                                 | `openai-responses`                                                  |
| `@ai-sdk/openai`，OpenAI OAuth 订阅                                       | `subscription-responses`                                            |
| `@ai-sdk/google`                                                          | `gemini`（`streamGenerateContent`）                                 |
| `@ai-sdk/amazon-bedrock`                                                  | `amazon-bedrock`（Converse；AWS 凭证链或 bearer token）             |
| `@ai-sdk/openai-compatible`、`@ai-sdk/deepseek`、`@ai-sdk/groq`、`@ai-sdk/mistral`、`@ai-sdk/xai` | `openai-chat`                       |
| Command Code                                                              | `openai-chat`                                                       |
| GitHub Copilot                                                            | `anthropic`、`openai-responses` 或 `openai-chat`（按模型选择）      |
| 插件目录中 `api.type: "native"` 且带 base URL 的条目                      | `openai-chat`                                                       |
| Azure OpenAI、Vertex Anthropic                                            | `azure` / `vertex-anthropic`，仅通过显式路由清单                    |

Bedrock 与 Copilot 的凭证流程是原生支持的：Bedrock 走 AWS 默认凭证链（`region` / `profile`，或 `AWS_BEARER_TOKEN_BEDROCK`），Copilot 的 device grant 通过该集成的 OAuth 凭证转发。两者都不需要只在产品侧实现。

## 清单结构

清单是一个 JSON 路由数组。所有字段都拒绝未知键，拼错会在启动时失败，而不是被忽略。

```jsonc
[
  {
    "id": "azure/gpt-5",
    "provider": "azure",
    "model": "gpt-5",
    "endpoint": "https://example.openai.azure.com/openai/deployments/gpt-5/chat/completions",
    "credential": { "type": "environment", "key": "AZURE_OPENAI_API_KEY" },
    "primary": true,
    "limit": { "context": 400000, "output": 128000 },
    "request": { "body": { "temperature": 0.2 } },
    "input_modalities": ["text", "image"],
    "default_variant": "fast",
    "variants": [{ "id": "fast", "body": { "reasoning_effort": "low" } }]
  }
]
```

| 字段              | 含义                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `id`              | 产品用于模型选择和账号变体的路由身份                                                                     |
| `provider`        | transport：`anthropic`、`openai-chat`、`openai-responses`、`subscription-responses`、`gemini`、`amazon-bedrock`、`azure`、`vertex-anthropic` |
| `model`           | 发给供应商的线路模型 id（不是产品的 `provider/model` 名称）                                              |
| `endpoint`        | 完整请求 URL；省略时使用 transport 默认值                                                               |
| `credential`      | 凭证引用（见下）；永远不是密钥本身                                                                       |
| `account`         | 不透明账号身份与 `model_key`；用于绑定指定账号而不重复模型                                               |
| `primary`         | owner 的默认路由；产品只为默认模型/账号组合标记一条                                                      |
| `prompt_cache`    | 让 transport 启用其 prompt cache 行为                                                                    |
| `auth`            | 声明式 auth 风格、可信 headers 与字面 query 参数                                                         |
| `request`         | 有界的生成参数 body 与可信 headers                                                                       |
| `variants`        | 可在 turn 边界选择的命名 body/headers；`default_variant` 指定默认                                         |
| `input_modalities`| 声明的输入类型（`text`、`image`）                                                                        |
| `limit`           | 声明的 context/output 容量，在角色绑定请求前检查                                                         |

## 凭证

`credential.type` 可为：

| 类型          | 字段                                  | 用途                                                           |
| ------------- | ------------------------------------- | -------------------------------------------------------------- |
| `database`    | `path`、`id`、`integration`           | 产品 broker 的凭证数据库（只读）                               |
| `legacy`      | `path`、`integration`                 | 旧凭证库，只读                                                 |
| `daemon`      | `path`、`id`、`integration`           | 独立 credential daemon 的 IPC 端点                             |
| `environment` | `key`，可选 `account`                 | 宿主环境变量；`account` 仅用于 subscription Responses          |
| `aws`         | `region`，可选 `profile`              | AWS 默认凭证链（Bedrock）                                      |

所有引用路径必须位于模型可写工作区之外；引擎会拒绝工作区内的凭证或路由文件。所有这些引用都按只读处理。

## Auth、请求参数与上限

`auth.style` 选择 transport 在凭证之外需要的线路约定：`bearer`（Anthropic 兼容路由上的 OAuth 风格 token）、`api-key`（`api-key` header，Azure 使用）和 `copilot`（Copilot 要求的 headers）。密钥本身仍来自 `credential`，永远不在这个块里。`auth.headers` 与 `auth.query` 是字面可信值；其中不能出现 `authorization`、`api-key`、`x-api-key`、`x-goog-api-key`、`chatgpt-account-id` 或 hop-by-hop headers。这个块没有任何放密钥的方式。

`azure` transport 读取 `AZURE_OPENAI_API_VERSION`（默认 `2024-10-21`），并把凭证作为 `api-key` 发送。`vertex-anthropic` 需要 `rawPredict` endpoint，并把凭证作为 bearer token 发送。

`request.body` 可以设置 temperature、reasoning effort 等生成参数，但不能替换模型、消息、工具、系统提示、stream 标志或 tool choice。未知键、重复 header、超过 64 KiB 的 body 或不受支持的 header 都会让启动失败。

清单上限为 1024 条路由、1 MiB。引擎的路由 schema 版本（`miao-engine --capabilities` 的 `routes_schema`）在字段增加或含义变化时递增，因此产品会拒绝已安装引擎读不懂的清单。

## 留在 TypeScript 的部分

- 线路协议既不是 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini、Bedrock Converse，也不是上面两种显式 endpoint 形式的供应商，无法表达为原生路由；它继续留在 TypeScript，而不是被近似模拟。
- 没有 AI SDK 包的插件目录条目，只有在声明 base URL 时才映射为 `openai-chat`；没有 base URL 就没有路由。
- 工作区内的路由或凭证文件按设计被拒绝。
- 路由清单是宿主内部的：操作者通过 miao 的供应商设置配置，而不是编辑原生清单。

## 验证

- `crates/miao-engine/src/model_routes.rs` — schema、上限、凭证与工作区校验、primary/variant 选择。
- `crates/miao-engine/src/routing.rs` — transport 构造与 auth 风格。
- `crates/miao-engine/tests/model_routes_cli.rs`、`provider_model_route.rs`、`route_limits.rs`、`default_route_auth.rs`、`bedrock.rs`、`copilot.rs` — 路由加载与线路行为。
- `packages/miao/src/engine/product-routes.ts` — 目录到路由的映射。
