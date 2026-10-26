# G0-5：插件钩子与每轮 session 亲和

状态：决定（2026-10-26）。对应 `specs/rust-phase-2.md` §3 的 G0-5 行。

## 1. 这一行包含两件事

| 缺口 | 原验收 |
|---|---|
| 插件 `aisdk` provider 钩子在原生路由上不执行 | 原生路由下钩子被调用 |
| 缺每轮 session-affinity 头 | 头与实际 session 一致 |

第二件已经具备，第一件需要按钩子家族分别定调，而不是笼统地"补上调用"。

## 2. 钩子：按家族区分

证据行号取自 2026-10-26 的 `main`。

| 钩子家族 | 原生路由上的行为 | 证据 |
|---|---|---|
| 工具钩子 `before` / `after` / `definition` | **调用** | 宿主把"哪几族注册了回调"写成 marker 文件经 `--plugin-hooks` 交给引擎；引擎在带标记的原生工具调用前后发起 `hook_tool` 反向 RPC，宿主在进程内按注册顺序执行并回传裁决 |
| `aisdk.sdk` / `aisdk.language` | **不调用**，且不应调用 | 钩子的输入输出是 `{model, package, options, sdk}`，作用是为 AI SDK 实例构造 SDK 与 language model；原生路由不创建 AI SDK 实例 |

工具钩子的具体位置：`packages/miao/src/engine/plugin-hooks.ts:18-70`（marker 与 `onHookTool`）、
`packages/miao/src/engine/client.ts:588`（`hook_tool` RPC）、`crates/miao-engine/src/product.rs:130`
（经宿主 settle 的钩子交换）、`crates/miao-engine/src/runtime.rs:3410`（单次工具调用的
`hook_tool` 交换）。三族的语义：`definition` 在原位改写描述与参数后回传，工具仍然被广告；
`before` 返回 deny 时以该消息拒绝调用，否则可替换参数；`after` 可替换工具输出。

`aisdk` 两个钩子的位置：`packages/core/src/plugin/host.ts:46-73`（注册）、
`packages/core/src/aisdk.ts:196-228`（只有走 AI SDK 的模型才会 `runSDK`/`runLanguage`）。
这两族钩子对长尾供应商照旧生效：未被原生接管的 `api.type === "aisdk"` 模型经 loopback 网关
（`packages/miao/src/engine/product-routes.ts:370-381`、`packages/core/src/provider-gateway.ts`）
翻译成该插件的 LanguageModel，钩子在那条路径上执行。

## 3. 判定

G0-5 的"钩子被调用"改为**"钩子在原生路由上按语义适用"**：

- 工具钩子语义适用，已实现，见 §2 第一行。
- `aisdk` 钩子对原生路由不适用：它们改写的对象（SDK 实例、language model）在原生路由上不存在，
  调用它们只会拿到 `sdk: undefined`。这是书面接受，不是缺口。

插件若要改变原生路由的 wire，应改目录字段而不是钩子：`api.url`、`api.settings`、
`model.request.body`/`headers`、`variants`，`profile()` 与引擎都读这些字段
（`packages/miao/src/engine/product-routes.ts:480-557`）。

**风险与缓解。** 插件作者若依赖 `aisdk.sdk` 改写某个已被原生路由接管的 provider，改写会失效。
缓解有两层：其一，原生路由的 wire 必须与插件产出等价，这正是 G0-1 的验收
（`specs/g0-1-route-parity.md`）；其二，等价测试逐 provider 断言完整五元组，插件改了 wire 会在
那一行失败，而不是静默丢字段。

## 4. 每轮 session 亲和：已具备

- `crates/miao-engine/src/cache_affinity.rs:14-45`：task-local 把亲和键、Session 键、affinity 名
  绑到一次 drain。`scoped_with(affinity, session, …)` 让 fork 共享亲和键但持有不同的 Session 键。
- `crates/miao-engine/src/openai_responses.rs:257,268`：body 的 `prompt_cache_key` 用亲和键，
  Subscription 档案另发 `session-id` 头。
- 路由 `auth.headers` 里的 `$session` 每轮解析成当前 Session 的不透明键
  （`crates/miao-engine/src/provider.rs:169-184`，product 侧声明见
  `packages/miao/src/engine/product-routes.ts:361-363`；非 Session 作用域的请求直接报错，
  不会退化成某个固定 ID）。
- 证据测试：`crates/miao-engine/tests/cache_affinity.rs`（
  `subscription_affinity_survives_retries_tools_and_runtime_restarts`、
  `shared_provider_isolates_concurrent_sessions_and_does_not_leak_into_unscoped_calls`、
  `fork_lineage_preserves_cache_hints_after_restart_without_joining_unrelated_sessions`）、
  `crates/miao-engine/src/provider.rs:196` 的
  `gateway_headers_follow_actual_session_across_protocols_and_model_selection`。

## 5. 关闭条件

G0-5 不需要新代码。关闭条件改为：§2 三行各自有上列证据；G0-1 的等价测试覆盖已被原生接管的
每个 provider。之后 `specs/rust-phase-2.md` 的 G0-5 行从"缺口"改为"已具备/书面接受"。
