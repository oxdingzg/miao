import { describe, expect } from "bun:test"
import { LLM } from "@miao/llm"
import { Effect } from "effect"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { InstallationVersion } from "@miao/core/installation/version"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { it } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"

// GitHub Copilot through the V2 route layer, against an in-process fake API.

const copilot = (input: {
  readonly id: string
  readonly package?: string
  readonly url?: string
  readonly endpoint?: string
}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(input.id),
    providerID: ProviderV2.ID.githubCopilot,
    name: input.id,
    api: {
      id: ModelV2.ID.make(input.id),
      type: "aisdk",
      package: input.package ?? "@ai-sdk/openai-compatible",
      url: input.url ?? "https://api.githubcopilot.com",
      settings: input.endpoint ? { endpoint: input.endpoint } : {},
    },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  })

const login = (metadata?: Record<string, string>) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("github-copilot-device"),
    access: "gho_access",
    refresh: "gho_token",
    expires: 0,
    ...(metadata ? { metadata } : {}),
  })

const lookup = { name: "lookup", description: "Lookup data", inputSchema: { type: "object" as const } }

const copilotHeaders = {
  authorization: "Bearer gho_token",
  "x-github-api-version": "2026-06-01",
  "openai-intent": "conversation-edits",
  "user-agent": `miao/${InstallationVersion}`,
}

describe("GitHub Copilot V2 route", () => {
  it.effect("sends GPT-5 class models through Responses with the Copilot token", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(copilot({ id: "gpt-6.1-sol" }), login())
      const { wire, response } = yield* exchange(
        LLM.request({ model, prompt: "Hello", tools: [lookup] }),
        sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"q":1}' },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":1}' },
          },
          { type: "response.completed", response: { id: "resp_1" } },
        ]),
      )

      expect(wire.url).toBe("https://api.githubcopilot.com/responses")
      expect(wire.headers).toMatchObject(copilotHeaders)
      // V1 copilot `chat.params` dropped maxOutputTokens for GPT models.
      expect(wire.body).not.toHaveProperty("max_output_tokens")
      expect(wire.body).toMatchObject({
        model: "gpt-6.1-sol",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        tools: [{ name: "lookup" }],
      })
      expect(response.toolCalls).toMatchObject([{ id: "call_1", name: "lookup", input: { q: 1 } }])
    }),
  )

  it.effect("keeps chat-completions models and mini variants on Chat", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(copilot({ id: "gpt-5-mini" }), login())
      const { wire, response } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([
          { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
          { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      )

      expect(wire.url).toBe("https://api.githubcopilot.com/chat/completions")
      expect(wire.headers).toMatchObject(copilotHeaders)
      expect(wire.body).not.toHaveProperty("max_tokens")
      expect(wire.body).not.toHaveProperty("store")
      expect(wire.body).not.toHaveProperty("reasoning_effort")
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("follows the endpoint the account's model list named", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        copilot({ id: "gpt-4.1", package: "@ai-sdk/github-copilot", endpoint: "responses" }),
        login(),
      )
      const { wire } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([{ type: "response.completed", response: { id: "resp_1" } }]),
      )
      expect(wire.url).toBe("https://api.githubcopilot.com/responses")
    }),
  )

  it.effect("sends Claude through Anthropic Messages under /v1 with bearer auth", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        copilot({
          id: "claude-sonnet-5",
          package: "@ai-sdk/anthropic",
          url: "https://api.githubcopilot.com/v1",
          endpoint: "messages",
        }),
        login(),
      )
      const { wire, response } = yield* exchange(
        LLM.request({ model, prompt: "Hello", tools: [lookup] }),
        sse([
          { type: "message_start", message: { usage: { input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]),
      )

      expect(wire.url).toBe("https://api.githubcopilot.com/v1/messages")
      expect(wire.headers).toMatchObject({
        ...copilotHeaders,
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
      })
      expect(wire.headers).not.toHaveProperty("x-api-key")
      // Copilot's /v1/messages shim rejects `eager_input_streaming` on tools.
      expect(JSON.stringify(wire.body)).not.toContain("eager_input_streaming")
      expect(wire.body).toMatchObject({ model: "claude-sonnet-5", max_tokens: 32_000 })
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("routes an Enterprise login to its Copilot API", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        copilot({ id: "gpt-6.1-sol" }),
        login({ enterpriseUrl: "company.ghe.com" }),
      )
      const { wire } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([{ type: "response.completed", response: { id: "resp_1" } }]),
      )
      expect(wire.url).toBe("https://copilot-api.company.ghe.com/responses")
    }),
  )

  it.effect("accepts a GITHUB_TOKEN key credential", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        copilot({ id: "gpt-4.1" }),
        Credential.Key.make({ type: "key", key: "ghp_env" }),
      )
      const { wire } = yield* exchange(
        LLM.request({ model, prompt: "Hello" }),
        sse([{ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] }]),
      )
      expect(wire.headers.authorization).toBe("Bearer ghp_env")
    }),
  )

  it.effect("reports every Copilot model as routable", () =>
    Effect.sync(() => {
      expect(SessionRunnerModel.supported(copilot({ id: "x", package: "@ai-sdk/github-copilot" }))).toBe(true)
    }),
  )
})

describe("Integration.legacyOAuth for Copilot", () => {
  it.effect("keeps the Enterprise domain of a V1 Copilot login", () =>
    Effect.sync(() => {
      expect(
        Integration.legacyOAuth(
          { type: "oauth", access: "gho", refresh: "gho", expires: 0, enterpriseUrl: "company.ghe.com" },
          Integration.MethodID.make("github-copilot-device"),
        ),
      ).toMatchObject({ refresh: "gho", expires: 0, metadata: { enterpriseUrl: "company.ghe.com" } })
    }),
  )
})
