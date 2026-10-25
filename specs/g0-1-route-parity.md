# G0-1：原生路由与 TS 路由的等价设计

状态：设计（2026-10-26）。前置阅读：`specs/rust-phase-2.md` §3 的 G0-1 行、§6「不做什么」。

## 1. 目的

G0-1 的验收是"逐个 provider 的等价路由测试：同一请求在两侧产生等价的 wire（含认证头、参数）"。
本文定义"等价"的判定口径、当前两侧的差集、每个 provider 的具体 wire 规则，以及测试放在哪里。
实现按 §5 的顺序逐个 provider 落地，每个 provider 一个 PR。

## 2. 什么叫"等价"

一次 provider turn 的 wire 由五元组决定：

| 维度 | 内容 |
|---|---|
| URL | 完整地址，含 path 与 query（部署名、api-version、region、project 等都在这里） |
| 认证 | 头名与来源：`Authorization: Bearer …`、`api-key: …`、`x-goog-api-key: …`，以及 OAuth 刷新的等价性 |
| 主机头 | 主机方要求的固定头（`x-goog-user-project`、`OpenAI-Intent`、`x-session-affinity` 一类） |
| body | 协议选择（chat / responses / messages / streamGenerateContent）与随协议变化的必填字段 |
| 重试与缓存 | 由引擎统一负责，不属于 provider 差异（见 G0-4） |

"等价"允许的差异只有两类，且必须在实现 PR 里逐条写出：

1. **SDK 噪声**：`user-agent` 后缀（`ai-sdk/azure/x.y.z` 对 `miao-engine/…`）、请求 ID 头等不影响服务端语义的头。
2. **书面接受的损失**：目前只有长尾 `@ai-sdk/*` 走宿主 loopback 网关这一类（见 §4）。

除此之外，任何一条不一致都算 G0-1 未通过。

## 3. 现状差集

`packages/miao/src/engine/product-routes.ts` 的 `profile()` 负责把目录里的模型映射成引擎路由；
`crates/miao-engine/src/routing.rs` 的 `build_*` 负责把路由名变成传输。两侧对得上才算有原生路由。

| provider | TS 侧（插件包） | 引擎传输 | 现状 |
|---|---|---|---|
| Anthropic 直连 | `@ai-sdk/anthropic` | `anthropic` | 已映射 |
| OpenAI Chat | `@ai-sdk/openai-compatible`、deepseek/groq/mistral/xai | `openai-chat` | 已映射 |
| OpenAI Responses | `@ai-sdk/openai`、`openai` 订阅 | `openai-responses`、`subscription-responses` | 已映射 |
| Gemini 直连 | `@ai-sdk/google` | `gemini` | 已映射 |
| Bedrock | `@ai-sdk/amazon-bedrock` | `amazon-bedrock`（SigV4 链） | 已映射 |
| **Azure Chat** | `@ai-sdk/azure`（`useCompletionUrls` 或 `sdk.chat`） | `azure` | **无 TS 映射，走网关** |
| **Azure Responses** | `@ai-sdk/azure`（默认：`sdk.responses`） | 无 | **两侧都缺**：TS 无映射；引擎 `openai-responses` 拒绝 `api-key` 与 query |
| **Vertex Anthropic** | `@ai-sdk/google-vertex/anthropic` | `vertex-anthropic`（bearer + rawPredict） | **无 TS 映射，走网关** |
| **Vertex Gemini** | `@ai-sdk/google-vertex` | 无 | **两侧都缺**：引擎 `gemini` 只支持 `x-goog-api-key` 直连，无 bearer/user-project |
| **Bedrock Mantle** | `@ai-sdk/amazon-bedrock/mantle` | 可用 `openai-chat` + bearer 承载 | **无 TS 映射，走网关** |

## 4. 每个 provider 的 wire 规则

规则来自已安装的 SDK 源码，引用行号指 `packages/core/node_modules/`。

### Azure Chat（`azure`）

- URL：默认 `https://{resourceName}.openai.azure.com/openai`；
  `useDeploymentBasedUrls` 时为 `…/openai/deployments/{model}/chat/completions`，
  否则 `…/openai/v1/chat/completions`（`@ai-sdk/azure/dist/index.mjs:88-107`）。
- query：`api-version={apiVersion}`，默认 `v1`；由 `AZURE_OPENAI_API_VERSION` 或路由 `auth.query` 给出。
- 认证：API key → `api-key` 头；Entra（`tokenProvider`）→ `Authorization: Bearer`。
- 引擎侧已具备：`OpenAIChat::with_azure`（`api-key` + `api-version`），`auth.style="bearer"` 可切到 Entra。
- 需要做：`profile()` 新增 azure 分支（资源名/部署名/版本/`useDeploymentBasedUrls` 取自
  `model.request.body` 与 `AZURE_RESOURCE_NAME`），以及两侧 wire 测试。

### Azure Responses（默认路径）

- URL：`…/openai/v1/responses`（`@ai-sdk/azure` 的 `responses` 模型），同样带 `api-version`。
- 认证：同 Azure Chat。
- 引擎侧缺：`openai_responses.rs:112-118` 明确拒绝 `api-key` 与任何 query。
- 需要做：允许 Responses 路由声明 `api-key` 认证与 `api-version` query（Azure 是它们唯一的使用者），
  然后补 `profile()` 分支与测试。**这是本清单里唯一需要改引擎传输的 Azure 项。**

### Vertex Anthropic

- URL：`{base}/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict`
  （流式；非流式为 `:rawPredict`，见 `@ai-sdk/google-vertex/dist/anthropic/index.mjs:124-133`），
  base 为 `https://{region}-aiplatform.googleapis.com`。
- 认证：`Authorization: Bearer {access_token}`（Google OAuth），常配 `x-goog-user-project: {project}`。
- 引擎侧已具备：`vertex-anthropic` 用 bearer，endpoint 由宿主给。
- 需要做：`profile()` 分支 + `x-goog-user-project` 头（走路由 `auth.headers`）+ 两侧测试。

### Vertex Gemini

- URL 两种模式（`@ai-sdk/google-vertex/dist/index.mjs:1101-1147`，模型路径来自 `@ai-sdk/google`）：
  - 标准：`https://{region}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{region}/publishers/google/models/{model}:streamGenerateContent?alt=sse`
  - express（API key）：`https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:streamGenerateContent?alt=sse`，
    无 project/location。
- 认证：标准模式 bearer（+`x-goog-user-project`）；express 模式 `x-goog-api-key`。
- 引擎侧缺：`gemini` 传输只有 API key；需要补 bearer 能力（或新增 `vertex-gemini` 路由名）。
- 需要做：引擎传输扩展 + `profile()` 分支 + 两侧测试。

### Bedrock Mantle

- URL：`https://bedrock-mantle.{region}.api.aws/v1/chat/completions`（或 `/v1/responses`），
  region 默认 `us-east-1`（`@ai-sdk/amazon-bedrock/dist/mantle/index.mjs:181-210`）。
- 认证：Bedrock API key → `Authorization: Bearer`。
- 引擎侧已具备：`openai-chat` + bearer + `endpoint`。
- 需要做：`profile()` 分支与两侧测试；不需要新传输。
- 待实现时确认：Mantle 是否要求额外头，以及 `responses` 变体是否也走同一 bearer。

### 长尾 `@ai-sdk/*`（书面接受，不逐个补原生路由）

`specs/rust-phase-2.md` §6 已定"保留 AI SDK 作为长尾兜底"。这类模型继续经
`provider-gateway.ts` 的 loopback 网关，wire 是标准 Chat Completions。G0-1 对这一类的
"等价"口径就是：网关收到的 body 与 TS 侧 AI SDK 请求一致，差异只有网关翻译层的已知丢弃项。
实现 PR 需要把丢弃项逐字段核对后写在这里（现有审计记录的说法是 reasoning/cache/response_format）。

## 5. 顺序与验收

按"引擎改动从小到大"落地，每个 provider 一个 PR，先加测试再加实现（同一 PR 内两段）：

1. Bedrock Mantle（只加 `profile()` 分支）
2. Azure Chat（加分支 + 引擎 `azure` 的 wire 测试）
3. Vertex Anthropic（加分支 + `x-goog-user-project` 头）
4. Azure Responses（唯一需要改引擎传输：`api-key` + query）
5. Vertex Gemini（引擎 `gemini` 支持 bearer / `vertex-gemini`）

每个 PR 的验收：

- `crates/miao-engine/tests/route_parity.rs`：捕获该 provider 实际发出的请求，断言 §2 五元组；
  测试名形如 `azure_chat_wire_matches_the_product_route`。
- `packages/miao/test/engine/route-parity.test.ts`：对同一模型条目断言 `profile()` 产出的
  `provider`/`endpoint`/`auth`，与 Rust 侧断言使用同一份期望值（期望值直接取自本文 §4 的表）。
- PR 描述里列出允许的差异（§2 的两类），不允许留空。

全部五步完成后，G0-1 行从"缺口"变为"已具备等价测试"，`provider-gateway.ts` 只剩长尾兜底一条路径。

## 6. 不做

- 不为了等价去复刻 SDK 的内部字段（`user-agent`、请求 ID、SDK 侧日志）。
- 不为长尾包逐个写原生传输；那与 §6 的长期决定冲突。
- 不改 placement 路由与 Session 归属（S1 的边界）。
