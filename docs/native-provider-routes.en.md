# Native engine provider routes

[简体中文](native-provider-routes.zh.md)

A Session placed on the native (Rust) engine reaches models through a **trusted
host route manifest**. The product generates that manifest from its model
catalog and active connections; it is not workspace configuration and a
model-writable file can never supply it. This page records the surface the
manifest supports, how the product maps a catalog model onto it, and what
deliberately stays on the TypeScript side.

The manifest carries credential **references** only. The engine never receives
a token through a controller command, never writes the credential store, and
never refreshes a credential itself; refresh stays with the product broker or
the standalone credential daemon.

## How the product picks a transport

The product derives one route per catalog model and integration connection. A
model that cannot be mapped is simply absent, so a Session that does not select
it keeps running on TypeScript. Selecting an unavailable model for a native
Session fails with `engine_routes_unsupported` instead of silently falling back.

| Product provider / `api.package`                                          | Native transport                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@ai-sdk/anthropic`                                                       | `anthropic` (`/v1/messages`)                                        |
| `@ai-sdk/openai`, API key                                                 | `openai-responses`                                                  |
| `@ai-sdk/openai`, OpenAI OAuth subscription                               | `subscription-responses`                                            |
| `@ai-sdk/google`                                                          | `gemini` (`streamGenerateContent`)                                  |
| `@ai-sdk/amazon-bedrock`                                                  | `amazon-bedrock` (Converse; AWS credential chain or bearer token)   |
| `@ai-sdk/openai-compatible`, `@ai-sdk/deepseek`, `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/xai` | `openai-chat`                       |
| Command Code                                                              | `openai-chat`                                                       |
| GitHub Copilot                                                            | `anthropic`, `openai-responses`, or `openai-chat` (per model)       |
| A plugin catalog entry with `api.type: "native"` and a base URL           | `openai-chat`                                                       |
| Azure OpenAI, Vertex Anthropic                                            | `azure` / `vertex-anthropic`, only through an explicit route manifest |

Bedrock and Copilot credential flows are native: Bedrock uses the AWS default
chain (`region` / `profile`, or `AWS_BEARER_TOKEN_BEDROCK`), and Copilot device
grants are forwarded as the integration's OAuth credential. Neither is
product-side-only.

## Manifest shape

The manifest is a JSON array of routes. Every field is deny-unknown, so a typo
fails startup rather than being ignored.

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

| Field             | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `id`              | Route identity the product uses for model selection and account variants                                |
| `provider`        | Transport: `anthropic`, `openai-chat`, `openai-responses`, `subscription-responses`, `gemini`, `amazon-bedrock`, `azure`, `vertex-anthropic` |
| `model`           | Wire model id sent to the provider (not the product's `provider/model` name)                            |
| `endpoint`        | Full request URL; omitted routes use the transport default                                             |
| `credential`      | Credential reference (see below); never a secret                                                        |
| `account`         | Opaque account identity plus `model_key`; used to route a pinned account without duplicating a model   |
| `primary`         | The default route for the owner; the product marks exactly one default model/account combination         |
| `prompt_cache`    | Ask the transport for its prompt-cache behavior                                                         |
| `auth`            | Declarative auth style, trusted headers, and literal query parameters                                   |
| `request`         | Bounded generation body and trusted headers                                                             |
| `variants`        | Named bodies/headers selectable at a turn boundary; `default_variant` picks one                          |
| `input_modalities`| Declared input kinds (`text`, `image`)                                                                  |
| `limit`           | Declared context/output capacity used before a role-bound request                                      |

## Credentials

`credential.type` is one of:

| Type          | Fields                                | Use                                                            |
| ------------- | ------------------------------------- | -------------------------------------------------------------- |
| `database`    | `path`, `id`, `integration`           | The product broker's credential database (read-only)           |
| `legacy`      | `path`, `integration`                 | An older credential store, read-only                           |
| `daemon`      | `path`, `id`, `integration`           | The standalone credential daemon over its IPC endpoint         |
| `environment` | `key`, optional `account`             | A host environment variable; `account` only for subscription Responses |
| `aws`         | `region`, optional `profile`          | The AWS default credential chain (Bedrock)                     |

Every referenced path must be outside the model-writable workspace; the engine
refuses a workspace-owned credential or route file. The engine treats all of
them as read-only.

## Auth, request options, and limits

`auth.style` selects a wire convention the transport needs beyond the
credential: `bearer` (OAuth-style tokens on Anthropic-compatible routes),
`api-key` (an `api-key` header, as Azure uses), and `copilot` (Copilot's
required headers). The secret itself still comes from `credential`, never from
this block. `auth.headers` and `auth.query` are literal trusted values; they
cannot contain `authorization`, `api-key`, `x-api-key`, `x-goog-api-key`,
`chatgpt-account-id`, or hop-by-hop headers. There is no way to put a secret in
this block.

The `azure` transport reads `AZURE_OPENAI_API_VERSION` (default `2024-10-21`)
and authenticates with the credential as an `api-key`. `vertex-anthropic`
expects a `rawPredict` endpoint and sends the credential as a bearer token.

`request.body` may set generation options such as temperature or reasoning
effort. It cannot replace the model, messages, tools, system prompt, stream
flags, or tool choice. Unknown keys, duplicate headers, a body over 64 KiB, or
an unsupported header fails startup.

The manifest is capped at 1024 routes and 1 MiB. The engine's route schema
version (`miao-engine --capabilities` reports `routes_schema`) moves whenever a
field is added or its meaning changes, so the product refuses a manifest the
installed engine cannot read.

## What stays on TypeScript

- A provider whose wire protocol is neither OpenAI Chat, OpenAI Responses,
  Anthropic Messages, Gemini, Bedrock Converse, nor the two declarative
  endpoint forms above cannot be expressed as a native route. It stays on
  TypeScript rather than being approximated.
- A plugin catalog entry with no AI SDK package is mapped to `openai-chat` only
  when it declares a base URL. Without one it has no route.
- A workspace-owned route or credential file is rejected by design.
- Route manifests are host-internal: operators configure providers through
  miao's provider settings, not by editing a native manifest.

## Verification

- `crates/miao-engine/src/model_routes.rs` — schema, bounds, credential and
  workspace validation, primary/variant selection.
- `crates/miao-engine/src/routing.rs` — transport construction and auth styles.
- `crates/miao-engine/tests/model_routes_cli.rs`, `provider_model_route.rs`,
  `route_limits.rs`, `default_route_auth.rs`, `bedrock.rs`, `copilot.rs` —
  route loading and wire behavior.
- `packages/miao/src/engine/product-routes.ts` — catalog-to-route mapping.
