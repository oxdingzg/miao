# MOD-03：AI SDK 长尾与 ADC 兜底退出路径

状态：**设计与清点完成，实现未开始**。基线 `1291ba4c45`。本项接续
[RUS-05 的兼容 worker 边界](rus05-runtime-boundaries.md) 与
[G0-1 路由等价的书面差异](g0-1-route-parity.md)；不改变 G0-1 的等价口径，只把
"长尾兜底"从隐含行为变成有清单、有测试、有可见标记的显式路径。

## 1. 今天真实发生的三类路由

`profile()`（`packages/miao/src/engine/product-routes.ts:488`）认领的模型直接生成原生路由；
它没认领的 `aisdk` 模型由 `unrouted` 补集
（`product-routes.ts:375`）交给进程内的 loopback gateway；两者都不接受的模型没有路由。

```ts
const unrouted = models.filter(
  (model) => !routed.has(`${model.providerID}/${model.id}`) && model.api.type === "aisdk",
)
```

清点数据：`~/.cache/miao/models-dev.json`（2026-10-29，227 provider / 8389 模型）

| 去向 | provider | 模型 | 代码路径 |
| --- | --- | --- | --- |
| 原生传输 | 208 | 6877 | `profile()` 分支 |
| loopback gateway | 18 | 1512 | `unrouted` → `ProviderGateway` |
| 无路由 | 1 | 0 | 该 provider 没有模型，不构成缺口 |

仍走 loopback gateway 的 18 个 provider（按模型数排降序）：

| provider | package | 模型 | 协议 |
| --- | --- | ---: | --- |
| vercel | `@ai-sdk/gateway` | 402 | AI SDK Gateway 自有协议 |
| openrouter | `@openrouter/ai-sdk-provider` | 390 | Chat Completions（`api` 已声明） |
| merge-gateway | `merge-gateway-ai-sdk-provider` | 195 | 自有协议 |
| aihubmix | `@aihubmix/ai-sdk-provider` | 137 | Chat Completions |
| venice | `venice-ai-sdk-provider` | 116 | Chat Completions |
| deepinfra | `@ai-sdk/deepinfra` | 71 | Chat Completions |
| sap-ai-core | `@jerome-benoit/sap-ai-provider-v2` | 50 | 自有协议 |
| cloudflare-ai-gateway | `ai-gateway-provider` | 50 | 自有协议 |
| gitlab | `gitlab-ai-provider` | 30 | 自有协议 |
| togetherai | `@ai-sdk/togetherai` | 29 | Chat Completions |
| cohere | `@ai-sdk/cohere` | 17 | Cohere v2 原生协议 |
| qvac | `@qvac/ai-sdk-provider` | 9 | 自有协议 |
| watsonx | `watsonx-ai-provider` | 5 | 自有协议 |
| perplexity | `@ai-sdk/perplexity` | 4 | Chat Completions |
| v0 | `@ai-sdk/vercel` | 3 | Chat Completions（`OpenAICompatibleChatLanguageModel` @ `api.v0.dev/v1`） |
| cerebras | `@ai-sdk/cerebras` | 2 | Chat Completions |
| standardcompute | `@openrouter/ai-sdk-provider` | 1 | Chat Completions（`api` 已声明） |
| salad-cloud | `@saladtechnologies-oss/ai-sdk-provider` | 1 | 自有协议 |

四个必须写下来的事实：

1. **兜底是隐式的。** `unrouted` 是"`profile()` 没认领"的补集，不是清单：上游 models.dev
   新增一个 package、或某个插件的 `npm` 改名，都会让它静默改走 JS 网关，没有任何测试或日志。
2. **网关不是第二套执行权威。** 它是 engine 进程内的 `Bun.serve`（port 0、随机 bearer，
   `provider-gateway.ts:61`），只做 Chat Completions ↔ `LanguageModelV3` 的翻译；不跑工具
   循环、不重试（`maxRetries: 0`，`provider-gateway.ts:138`）。符合 RUS-05 §2 的边界，但它是
   一次真实的 JS 运行时依赖，所以必须显式。
3. **规模上限是真实风险。** 路由表有 1024 条与 1 MiB 两条硬上限
   （`product-routes.ts:420`、`product-routes.ts:428`）。路由按"模型 × 账号"展开，长尾
   1512 个模型叠上多账号就可能直接以 `engine_routes_limit` 启动失败。收窄网关集合不只是
   维护成本，也是让目录装进上限的手段。
4. **`api.type === "native"` 且没有 `api.url` 的模型会静默消失。** `profile()` 返回
   `undefined`，而 `unrouted` 只收 `aisdk`，于是模型既不进原生路由也不进网关；若它正好是
   默认模型，启动会以 `engine_routes_unsupported` 失败（`product-routes.ts:416`），否则只是
   从目录里少一项。当前 models.dev 没有这类条目，只有用户配置 `npm: null` 才能触发。

## 2. 判定：原生迁移、显式兼容 worker、不迁移

判据按顺序三条：协议是否就是 Chat Completions；原生 `openai-chat` 传输出是否保得住该
provider 的请求/响应字段；凭据或签名能否在引擎内复制。只满足前两条才迁移。

### A. 原生迁移（补 `defaults` base + 路由测试）

| provider | package | 模型 |
| --- | --- | ---: |
| openrouter | `@openrouter/ai-sdk-provider` | 390 |
| aihubmix | `@aihubmix/ai-sdk-provider` | 137 |
| venice | `venice-ai-sdk-provider` | 116 |
| deepinfra | `@ai-sdk/deepinfra` | 71 |
| togetherai | `@ai-sdk/togetherai` | 29 |
| perplexity | `@ai-sdk/perplexity` | 4 |
| v0 | `@ai-sdk/vercel` | 3 |
| cerebras | `@ai-sdk/cerebras` | 2 |
| standardcompute | `@openrouter/ai-sdk-provider` | 1 |

合计 753 个模型可脱离 JS 网关。`openrouter` 与 `standardcompute` 的 `api` 已由目录声明，
其余需要在 `profile()` 的 `defaults` 表里补 base。分类核对自各 SDK 的 dist 产物：
deepinfra（`api.deepinfra.com/v1`）、cerebras（`api.cerebras.ai/v1`）、togetherai
（`api.together.xyz/v1`）、v0（`api.v0.dev/v1`）、aihubmix（`aihubmix.com`）都实例化
`OpenAICompatibleChatLanguageModel`，venice 走 `/api/v1/chat/completions`；这些 base 迁移时
照抄 SDK 默认值，并在 wire 测试里固定，不从记忆或文档填写。perplexity 是唯一的例外：它用
自有的 `PerplexityLanguageModel` 而不是 OpenAI 兼容类，迁移前必须先用 wire 测试确认响应可
等价映射，不成立就移入 B 组。

`openai-chat` 传输已经双向保留 `reasoning_content`、`usage`（含 `cached_tokens` 与
`reasoning_tokens`）、`tool_calls` 与 `request.body` 里非受保护键
（`crates/miao-engine/src/openai_chat.rs`、`crates/miao-engine/src/request_options.rs:29`），
所以这组迁移不以丢掉 reasoning 或 cache 为代价。

### B. 明确保留的兼容 worker（协议不是 Chat Completions）

| provider | 模型 | 保留原因 |
| --- | ---: | --- |
| vercel (`@ai-sdk/gateway`) | 402 | AI SDK Gateway 自有请求体；它的卖点就是转发多种协议 |
| merge-gateway | 195 | 自有协议 |
| sap-ai-core | 50 | 自有协议，且由运行时 npm 安装 provider 包 |
| cloudflare-ai-gateway | 50 | 自有协议 |
| gitlab | 30 | 自有协议（GitLab Duo） |
| cohere | 17 | Cohere v2 不是 Chat Completions |
| qvac | 9 | 自有协议 |
| watsonx | 5 | 自有协议 |
| salad-cloud | 1 | 自有协议 |

合计 759 个模型保留 loopback gateway，但按 §4 的 S3 变成显式兼容 worker：路由带
`compat: "gateway"` 标记，网关只在清单内且用户启用了对应 provider 时才启动。

### C. 凭据不可复制（留在宿主，不进原生路由）

- **Vertex 的 Application Default Credentials**：`Source` 只有 Aws / Static / Database /
  Legacy / Daemon，而 ADC 的令牌链在 `google-auth-library` 里；`google-vertex` 分支因此只
  接"令牌是已存凭据"的账号。
- **Bedrock 的 AWS SDK 签名**：引擎已有 `bedrock` 传输，但 Mantle 的 SDK-key 组合仍按
  `x-api-key`/SDK 两条路走；ADC 与 SDK 默认链不可复制时保留网关。

这两类不是待迁移项，是记录在案的**已接受差异**；改动它们需要各自的凭据设计。

### D. 拒绝

`native` 类型缺 `api.url` 的模型改为明确的诊断，而不是从目录里消失；若它是默认模型，
`engine_routes_unsupported` 的错误文案要点名 provider 与"缺少 base URL"。

## 3. 已接受差异（逐字段，来自代码）

loopback gateway 保住的：`text`、`reasoning_content`、`tool_calls`（含
`providerMetadata.google.thoughtSignature` 回传）、`usage`（`prompt_tokens_details.cached_tokens`
与 `completion_tokens_details.reasoning_tokens`，`provider-gateway.ts:342`）、
`temperature`/`top_p`/`max_tokens`/`max_completion_tokens`/`stop`、`data:` 形式的图片。

loopback gateway 丢掉的（`ChatRequestSchema`，`provider-gateway.ts:24`）：

| 字段 | 原因 |
| --- | --- |
| `response_format` 等 JSON 模式 | schema 没有该字段，解码时丢弃 |
| `http(s)://` 图片 | 只接受 `data:` base64 |
| 文件、音频等非文本/图片 part | 未映射 |
| provider 专属请求体（`request.body` 的其余键） | 引擎原样发给网关，但 gateway 只解码 schema 内字段 |

最后一条是 B 组留在网关的根本代价：**原生传输会透传 `request.body`，网关不会**。任何依赖
provider 专属参数（thinking 预算、`reasoning_effort` 之类）来省 token 的 provider 都因此
不该进 B 组，而应迁到 A 组或明确接受差异。

## 4. 落地切片

每个切片单独 PR，顺序即合并顺序。

- **S1 显式清单（无行为变化）**：`product-routes.ts` 增加 `GATEWAY_PACKAGES` 常量，替代
  `unrouted` 的补集；不在原生清单也不在 `GATEWAY_PACKAGES` 里的 `aisdk` package 生成
  `engine_routes_unsupported_package` 诊断。测试用 `models-dev.json` 的 package 集合断言
  每个 package 恰好落在原生、网关或明确拒绝三者之一。
- **S2 A 组迁移**：一个 provider 一个 PR，先加 `packages/miao/test/engine/route-parity.test.ts`
  条目再改 `profile()`；每个迁移完成即从 `GATEWAY_PACKAGES` 删除。
- **S3 显式兼容标记**：网关路由带 `compat: "gateway"`；网关只在清单内 provider 启用时启动，
  启动/诊断日志各记一条。
- **S4 D 组拒绝**：把"静默消失"改成点名报错。

## 5. 验收清单映射

| MOD-03 验收项 | 本设计对应 |
| --- | --- |
| 清点仍依赖 gateway、ADC 和插件 provider 的真实路由 | §1 的 18 个 provider / 1512 模型、§2C 两类凭据 |
| 按需求决定原生迁移或明确可选兼容 worker | §2 的 A/B/C/D 四组判定与切片 |
| 保留每条已接受差异，不以静默丢 reasoning/cache 作为等价 | §3 逐字段表；§2A 证明迁移不以丢失为代价 |

产品侧的验收（诊断可见、启动不因长尾超限）需要 S1 与 S3 落地后另记，本文不声明已经完成。
