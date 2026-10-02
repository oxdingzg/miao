import { describe, expect } from "bun:test"
import { LLM } from "@miao/llm"
import { Effect } from "effect"
import { Credential } from "@miao/core/credential"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { it } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"

// Azure OpenAI through the V2 route layer, against an in-process fake API.

const azure = (input: {
  readonly id?: string
  readonly package?: string
  readonly url?: string
  readonly settings?: Record<string, unknown>
  readonly body?: Record<string, string>
  readonly headers?: Record<string, string>
}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(input.id ?? "gpt-6.1-sol"),
    providerID: ProviderV2.ID.azure,
    name: "Azure model",
    api: {
      id: ModelV2.ID.make(input.id ?? "gpt-6.1-sol"),
      type: "aisdk",
      package: input.package ?? "@ai-sdk/azure",
      ...(input.url ? { url: input.url } : {}),
      settings: input.settings ?? {},
    },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    request: { headers: input.headers ?? {}, body: input.body ?? {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 400_000, output: 128_000 },
  })

const key = Credential.Key.make({ type: "key", key: "azure-key" })
const responsesStream = sse([
  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
  { type: "response.completed", response: { id: "resp_1" } },
])
const chatStream = sse([
  { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
  { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
])

describe("Azure OpenAI V2 route", () => {
  it.effect("builds the v1 Responses URL from the resource name with an api-key header", () =>
    Effect.gen(function* () {
      // The V2 Azure plugin writes the resource name into the request body.
      const model = yield* SessionRunnerModel.fromCatalogModel(azure({ body: { resourceName: "contoso" } }), key)
      const { wire, response } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)

      expect(wire.url).toBe("https://contoso.openai.azure.com/openai/v1/responses?api-version=v1")
      expect(wire.headers["api-key"]).toBe("azure-key")
      expect(wire.headers).not.toHaveProperty("authorization")
      // Route settings stay off the wire.
      expect(wire.body).not.toHaveProperty("resourceName")
      expect(wire.body).toMatchObject({ model: "gpt-6.1-sol", store: false })
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("honours apiVersion and useCompletionUrls from the migrated provider settings", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({ settings: { resourceName: "contoso", apiVersion: "2025-04-01-preview", useCompletionUrls: true } }),
        key,
      )
      const { wire, response } = yield* exchange(LLM.request({ model, prompt: "Hello" }), chatStream)

      expect(wire.url).toBe(
        "https://contoso.openai.azure.com/openai/v1/chat/completions?api-version=2025-04-01-preview",
      )
      expect(wire.body).not.toHaveProperty("apiVersion")
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("addresses a deployment when deployment URLs are requested", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({
          id: "my-deployment",
          settings: {
            resourceName: "contoso",
            useDeploymentBasedUrls: true,
            useCompletionUrls: true,
            apiVersion: "2024-10-21",
          },
        }),
        key,
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), chatStream)
      expect(wire.url).toBe(
        "https://contoso.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21",
      )
    }),
  )

  it.effect("uses a configured base URL as-is", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({ url: "https://gateway.example/openai/v1" }),
        key,
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)
      expect(wire.url).toBe("https://gateway.example/openai/v1/responses?api-version=v1")
    }),
  )

  it.effect("sends a configured Entra bearer token instead of an api-key", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({ settings: { resourceName: "contoso" }, headers: { Authorization: "Bearer entra-token" } }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)

      expect(wire.headers.authorization).toBe("Bearer entra-token")
      expect(wire.headers).not.toHaveProperty("api-key")
    }),
  )

  it.effect("expands the resource template of Azure AI Foundry models", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({
          id: "claude-sonnet-5",
          package: "@ai-sdk/anthropic",
          url: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1",
          body: { resourceName: "contoso" },
        }),
        key,
      )
      const { wire } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([
          { type: "message_start", message: { usage: { input_tokens: 5 } } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        ]),
      )

      expect(wire.url).toBe("https://contoso.services.ai.azure.com/anthropic/v1/messages")
      expect(wire.headers["x-api-key"]).toBe("azure-key")
      expect(wire.body).not.toHaveProperty("resourceName")
    }),
  )

  it.effect("does not send the AZURE_RESOURCE_NAME env connection as the API key", () =>
    Effect.gen(function* () {
      const previous = { name: process.env.AZURE_RESOURCE_NAME, key: process.env.AZURE_API_KEY }
      process.env.AZURE_RESOURCE_NAME = "contoso"
      process.env.AZURE_API_KEY = "real-azure-key"
      // models.dev lists AZURE_RESOURCE_NAME first, so the env connection resolves to it.
      const model = yield* SessionRunnerModel.fromCatalogModel(
        azure({}),
        Credential.Key.make({ type: "key", key: "contoso" }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)
      process.env.AZURE_RESOURCE_NAME = previous.name
      process.env.AZURE_API_KEY = previous.key
      if (previous.name === undefined) delete process.env.AZURE_RESOURCE_NAME
      if (previous.key === undefined) delete process.env.AZURE_API_KEY

      expect(wire.url).toStartWith("https://contoso.openai.azure.com/openai/v1/responses")
      expect(wire.headers["api-key"]).toBe("real-azure-key")
    }),
  )

  it.effect("rejects an Azure model with neither a resource name nor a URL", () =>
    Effect.gen(function* () {
      const previous = process.env.AZURE_RESOURCE_NAME
      delete process.env.AZURE_RESOURCE_NAME
      const failure = yield* SessionRunnerModel.fromCatalogModel(azure({}), key).pipe(Effect.flip)
      if (previous !== undefined) process.env.AZURE_RESOURCE_NAME = previous
      expect(failure._tag).toBe("SessionRunnerModel.UnsupportedApiError")
      expect(SessionRunnerModel.supported(azure({ settings: { resourceName: "contoso" } }))).toBe(true)
    }),
  )
})
