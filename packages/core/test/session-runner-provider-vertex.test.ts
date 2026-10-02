import { describe, expect } from "bun:test"
import { LLM } from "@miao/llm"
import { Effect } from "effect"
import { Credential } from "@miao/core/credential"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { it } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"

// Google Vertex AI through the V2 route layer, against an in-process fake API.
// A configured Authorization header stands in for the ADC token so no Google
// endpoint is contacted.

const vertex = (input: {
  readonly id: string
  readonly package: string
  readonly url?: string
  readonly body?: Record<string, string>
  readonly headers?: Record<string, string>
}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(input.id),
    providerID: ProviderV2.ID.googleVertex,
    name: input.id,
    api: {
      id: ModelV2.ID.make(input.id),
      type: "aisdk",
      package: input.package,
      ...(input.url ? { url: input.url } : {}),
      settings: {},
    },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    request: {
      headers: input.headers ?? { Authorization: "Bearer adc-token" },
      // The V2 Vertex plugin resolves project and location into the request body.
      body: input.body ?? { project: "acme", location: "us-east5" },
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 64_000 },
  })

const geminiStream = sse([
  {
    candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  },
])

const anthropicStream = sse([
  { type: "message_start", message: { usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
])

describe("Google Vertex V2 route", () => {
  it.effect("sends Gemini to the project's regional generateContent endpoint", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        vertex({ id: "gemini-3.5-pro", package: "@ai-sdk/google-vertex" }),
      )
      const { wire, response } = yield* exchange(LLM.request({ model, prompt: "Hello" }), geminiStream)

      expect(wire.url).toBe(
        "https://us-east5-aiplatform.googleapis.com/v1/projects/acme/locations/us-east5/publishers/google/models/gemini-3.5-pro:streamGenerateContent?alt=sse",
      )
      expect(wire.headers.authorization).toBe("Bearer adc-token")
      expect(wire.body).not.toHaveProperty("project")
      expect(wire.body).not.toHaveProperty("location")
      expect(wire.body).toMatchObject({ contents: [{ role: "user" }] })
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("uses express mode for a Vertex API key without a project", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        vertex({ id: "gemini-3.5-flash", package: "@ai-sdk/google-vertex", body: {}, headers: {} }),
        Credential.Key.make({ type: "key", key: "vertex-key" }),
      )
      const previous = ["GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"].map(
        (name) => [name, process.env[name]] as const,
      )
      previous.forEach(([name]) => delete process.env[name])
      const result = yield* exchange(LLM.request({ model, prompt: "Hello" }), geminiStream)
      previous.forEach(([name, value]) => (value === undefined ? undefined : (process.env[name] = value)))

      expect(result.wire.url).toBe(
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
      )
      expect(result.wire.headers["x-goog-api-key"]).toBe("vertex-key")
    }),
  )

  it.effect("sends Claude through rawPredict with the Vertex body", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        vertex({
          id: "claude-sonnet-5@default",
          package: "@ai-sdk/google-vertex/anthropic",
          body: { project: "acme", location: "global" },
        }),
      )
      const { wire, response } = yield* exchange(LLM.request({ model, prompt: "Hello" }), anthropicStream)

      expect(wire.url).toBe(
        "https://aiplatform.googleapis.com/v1/projects/acme/locations/global/publishers/anthropic/models/claude-sonnet-5@default:streamRawPredict",
      )
      expect(wire.headers.authorization).toBe("Bearer adc-token")
      expect(wire.body).not.toHaveProperty("model")
      expect(wire.body).toMatchObject({ anthropic_version: "vertex-2023-10-16", stream: true, max_tokens: 64_000 })
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("puts Claude in a continental multi-region on the regional endpoint platform", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        vertex({
          id: "claude-opus-5@default",
          package: "@ai-sdk/google-vertex/anthropic",
          body: { project: "acme", location: "eu" },
        }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), anthropicStream)
      expect(wire.url).toStartWith("https://aiplatform.eu.rep.googleapis.com/v1/projects/acme/locations/eu/")
    }),
  )

  it.effect("expands the catalog URL template of partner (MaaS) models", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        vertex({
          id: "zai-org/glm-5-maas",
          package: "@ai-sdk/openai-compatible",
          url: "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/endpoints/openapi",
          body: { project: "acme", location: "global" },
        }),
      )
      const { wire, response } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([
          { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
          { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      )

      expect(wire.url).toBe(
        "https://aiplatform.googleapis.com/v1/projects/acme/locations/global/endpoints/openapi/chat/completions",
      )
      expect(wire.headers.authorization).toBe("Bearer adc-token")
      expect(wire.body).not.toHaveProperty("project")
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("reports Vertex models as routable", () =>
    Effect.sync(() => {
      expect(SessionRunnerModel.supported(vertex({ id: "gemini", package: "@ai-sdk/google-vertex" }))).toBe(true)
      expect(
        SessionRunnerModel.supported(vertex({ id: "claude", package: "@ai-sdk/google-vertex/anthropic" })),
      ).toBe(true)
    }),
  )
})
