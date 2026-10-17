# Runtime cache controls

Cache behavior belongs to a deployment and a selected wire model. The Responses protocol alone
cannot prove that a compatible gateway, subscription endpoint or older model accepts newer cache
options. Existing models keep their previous wire format unless a capability is explicitly bound.

## Bind a model in the SDK

```ts
import { LLM } from "@miao/llm"
import { OpenAIResponses } from "@miao/llm/protocols/openai-responses"

const model = OpenAIResponses.route.with({ endpoint: { baseURL: "https://api.example/v1" } }).model({
  id: "wire-model",
  compatibility: {
    responsesCache: {
      profile: "breakpoints",
      model: "wire-model",
      endpoint: "https://api.example/v1/responses",
    },
  },
})

const request = LLM.request({
  model,
  system: "Stable instructions and shared reference material.",
  prompt: "The current task.",
  providerOptions: {
    openai: { promptCacheOptions: { mode: "implicit", ttl: "30m" } },
  },
})
```

The declaration is an assertion by the deployment owner, not automatic capability discovery.
Before transport, the compiler checks the protocol, wire-model ID, complete rendered endpoint
and query settings. A subscription reroute or a model override cannot inherit an unrelated API
binding. Endpoint callbacks are checked against the real validated body, so route aliases and
WebSocket lowering share the same logical resource contract.

For a breakpoint-capable declaration, stable system text becomes a developer `input_text` block
with an explicit breakpoint. The default mode remains `implicit`, preserving the server's eligible
conversation-tail caching. Moving tool/message markers on every request is not required for this
stable-prefix policy. No context or dummy messages are added when there is no system text.

`promptCacheOptions` supports `mode: implicit|explicit`, `ttl: 30m` and an explicit `prewarm`
boolean. Explicit-only caching without a real system breakpoint is rejected unless `cache: none`
intentionally disables cache writes. `cache: none` cannot simultaneously enable implicit writes or
prewarming. Other TTLs are rejected rather than silently approximated.

## Legacy deployments

A `profile: legacy` declaration supports semantic `promptCacheRetention: in_memory|24h` instead
of modern cache options. The two families are not mixed. With no declaration, the SDK still sends
its existing system/input representation and optional cache key; it does not infer support from
model names. Advanced semantic options without a matching declaration fail before transport.

The generic `cache: none` policy cannot promise that an older server disables its own implicit
cache. Its existing client-side marker behavior remains unchanged outside the bound modern path.

## Catalog model settings

For a TS catalog model using the Responses SDK route, these `request.body` settings are recognized
as deployment settings instead of raw HTTP body fields:

```json
{
  "responsesCache": {
    "profile": "breakpoints",
    "model": "wire-model",
    "endpoint": "https://api.example/v1/responses"
  },
  "promptCacheOptions": { "mode": "implicit", "ttl": "30m" }
}
```

The model resolver validates the declaration, attaches it to the SDK model compatibility metadata,
and removes these configuration names from the outgoing body. Legacy retention uses the same
`responsesCache` declaration with `profile: legacy` and `promptCacheRetention: 24h`.

Other model protocols reject the declaration rather than forwarding it as an unknown provider
parameter. When a bound contract is active, use semantic provider options for cache controls;
raw `http.body.prompt_cache_options` and retention overrides are rejected, as are raw model-ID
changes. The breakpoint profile also requires semantic messages rather than a raw `input`
override, so unvalidated markers cannot bypass the selected policy. Authentication remains owned
by the route and must be configured independently.

Generation-free prewarming is available as an intentional low-level SDK request. It is not a
normal agent-model default: setting `prewarm: true` in catalog defaults is rejected, because it
would suppress every ordinary model response. This feature does not schedule prewarming itself.

## Measurement

Compare observed cache reads, cache writes, ordinary input, output, successful tasks and total
latency. A hit percentage is not a cost estimate. Missing usage axes stay distinguishable from
measured zero; prices and cache accounting differ between deployments. The native engine's
`provider.request.cache_diagnostics` and usage coverage report explain observed client changes,
not unobservable server eviction or KV-cache state.
