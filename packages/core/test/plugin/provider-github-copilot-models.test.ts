import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { Integration } from "@miao/core/integration"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { PluginHost } from "@miao/core/plugin/host"
import { GithubCopilotPlugin } from "@miao/core/plugin/provider/github-copilot"
import { ProviderV2 } from "@miao/core/provider"
import { testEffect } from "../lib/effect"
import { pluginTestLayer } from "./fixture"

const copilotID = ProviderV2.ID.githubCopilot
const modelID = (id: string) => ModelV2.ID.make(id)

const remote = (input: {
  readonly id: string
  readonly picker?: boolean
  readonly endpoints: ReadonlyArray<string>
  readonly efforts?: ReadonlyArray<string>
  readonly vision?: boolean
}) => ({
  model_picker_enabled: input.picker ?? true,
  id: input.id,
  name: `Remote ${input.id}`,
  version: `${input.id}-2026-05-01`,
  supported_endpoints: input.endpoints,
  billing: { token_prices: { batch_size: 10_000, default: { cache_price: 1, input_price: 10, output_price: 40 } } },
  capabilities: {
    family: input.id,
    limits: {
      max_context_window_tokens: 400_000,
      max_prompt_tokens: 272_000,
      max_output_tokens: 128_000,
      ...(input.vision ? { vision: { supported_media_types: ["image/png", "application/pdf"] } } : {}),
    },
    supports: {
      tool_calls: true,
      vision: input.vision ?? false,
      ...(input.efforts ? { reasoning_effort: input.efforts } : {}),
    },
  },
})

// What `GET {copilot}/models` answers for one Copilot account (shape recorded
// from the V1 plugin's fixture): a GPT on Responses, a Claude on Messages, a
// utility model hidden from the picker, and a disabled one that must be skipped.
const answer = JSON.stringify({
  data: [
    remote({ id: "gpt-6.1-sol", endpoints: ["/responses", "/chat/completions"], efforts: ["low", "high"], vision: true }),
    remote({ id: "claude-sonnet-5", endpoints: ["/v1/messages", "/chat/completions"] }),
    remote({ id: "gpt-4.1", endpoints: ["/chat/completions"], picker: false }),
    { ...remote({ id: "gpt-retired", endpoints: ["/chat/completions"] }), policy: { state: "disabled" } },
  ],
})

type Calls = { readonly urls: Array<string>; readonly headers: Array<Record<string, string>> }

const suite = () => {
  const calls = Ref.makeUnsafe<Calls>({ urls: [], headers: [] })
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (current) => ({
        urls: [...current.urls, request.url],
        headers: [...current.headers, { ...request.headers }],
      }))
      return HttpClientResponse.fromWeb(request, new Response(answer, { status: 200 }))
    }),
  )
  return {
    calls,
    it: testEffect(
      Layer.fresh(pluginTestLayer([[LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)]])),
    ),
  }
}

const github = suite()
const enterprise = suite()
const unauthenticated = suite()

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* GithubCopilotPlugin.effect(host)
})

const seed = Effect.fn(function* (metadata?: Record<string, string>) {
  const catalog = yield* Catalog.Service
  const credentials = yield* Credential.Service
  if (metadata !== undefined)
    yield* credentials.create({
      integrationID: Integration.ID.make("github-copilot"),
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("github-copilot-device"),
        access: "gho_token",
        refresh: "gho_token",
        expires: 0,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }),
    })
  // models.dev lists Copilot as an OpenAI-compatible provider.
  yield* catalog.transform((draft) => {
    draft.provider.update(copilotID, (provider) => {
      provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.githubcopilot.com" }
    })
    for (const id of ["gpt-6.1-sol", "claude-sonnet-5", "gpt-5-chat-latest", "grok-gone"])
      draft.model.update(copilotID, modelID(id), (model) => {
        model.name = `Catalog ${id}`
        model.api = { type: "aisdk", id: modelID(id), package: "@ai-sdk/openai-compatible" }
      })
  })
})

describe("GithubCopilotPlugin model list", () => {
  github.it.effect("rebuilds the Copilot catalog from the account's model list", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed({})
      yield* addPlugin()

      const calls = yield* Ref.get(github.calls)
      expect(calls.urls).toEqual(["https://api.githubcopilot.com/models"])
      expect(calls.headers[0]).toMatchObject({
        authorization: "Bearer gho_token",
        "x-github-api-version": "2026-06-01",
      })

      // Entries the account cannot call are pruned.
      expect(yield* catalog.model.get(copilotID, modelID("grok-gone"))).toBeUndefined()
      expect(yield* catalog.model.get(copilotID, modelID("gpt-5-chat-latest"))).toBeUndefined()
      expect(yield* catalog.model.get(copilotID, modelID("gpt-retired"))).toBeUndefined()

      const gpt = yield* catalog.model.get(copilotID, modelID("gpt-6.1-sol"))
      expect(gpt).toMatchObject({
        name: "Catalog gpt-6.1-sol",
        api: {
          type: "aisdk",
          package: "@ai-sdk/github-copilot",
          url: "https://api.githubcopilot.com",
          settings: { endpoint: "responses" },
        },
        capabilities: { tools: true, input: ["text", "image", "pdf"] },
        limit: { context: 400_000, input: 272_000, output: 128_000 },
        cost: [{ input: 10, output: 40, cache: { read: 1, write: 0 } }],
        enabled: true,
      })
      expect(gpt?.variants.map((variant) => ({ id: String(variant.id), body: variant.body as unknown }))).toEqual(
        ["low", "high"].map((effort) => ({
          id: effort,
          body: { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] },
        })),
      )

      expect(yield* catalog.model.get(copilotID, modelID("claude-sonnet-5"))).toMatchObject({
        api: { package: "@ai-sdk/anthropic", url: "https://api.githubcopilot.com/v1", settings: { endpoint: "messages" } },
        variants: [],
      })
      // Utility models are kept for internal use but hidden from the picker.
      expect(yield* catalog.model.get(copilotID, modelID("gpt-4.1"))).toMatchObject({
        name: "Remote gpt-4.1",
        enabled: false,
        api: { settings: { endpoint: "chat" } },
      })
    }),
  )

  enterprise.it.effect("asks the Enterprise Copilot API for an Enterprise login", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seed({ enterpriseUrl: "company.ghe.com" })
      yield* addPlugin()

      expect((yield* Ref.get(enterprise.calls)).urls).toEqual(["https://copilot-api.company.ghe.com/models"])
      expect((yield* catalog.model.get(copilotID, modelID("gpt-6.1-sol")))?.api.url).toBe(
        "https://copilot-api.company.ghe.com",
      )
    }),
  )

  unauthenticated.it.effect("keeps the models.dev catalog and registers the device login without a Copilot login", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* seed()
      yield* addPlugin()

      expect((yield* Ref.get(unauthenticated.calls)).urls).toEqual([])
      expect((yield* catalog.model.get(copilotID, modelID("grok-gone")))?.name).toBe("Catalog grok-gone")
      expect(
        (yield* integrations.get(Integration.ID.make("github-copilot")))?.methods.find(
          (method) => method.type === "oauth",
        ),
      ).toMatchObject({ id: "github-copilot-device", label: "Login with GitHub Copilot" })
    }),
  )
})
