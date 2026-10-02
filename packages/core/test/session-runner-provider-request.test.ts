import { describe, expect } from "bun:test"
import { LLM, Message } from "@miao/llm"
import { Effect } from "effect"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { InstallationVersion } from "@miao/core/installation/version"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { SessionRunnerProviderHeaders } from "@miao/core/session/runner/provider-headers"
import { it } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"

// Request shapes the V1 provider plugins produced through `chat.headers` and
// `chat.params`, now built by the V2 route layer. Each case runs the real route
// pipeline against an in-process fake provider, so no provider API is called.

const catalog = (input: {
  readonly providerID: string
  readonly package: string
  readonly url?: string
  readonly apiID?: string
}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(input.apiID ?? "gpt-6.1-sol"),
    providerID: ProviderV2.ID.make(input.providerID),
    name: "Test model",
    api: {
      id: ModelV2.ID.make(input.apiID ?? "gpt-6.1-sol"),
      type: "aisdk",
      package: input.package,
      ...(input.url ? { url: input.url } : {}),
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 400_000, output: 128_000 },
  })

const responsesStream = sse([
  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
  { type: "response.completed", response: { id: "resp_1" } },
])

const chatStream = sse([
  { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
  { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
])

const turnHeaders = (providerID: string, messages = [Message.user("Hello")], parentID?: string) =>
  SessionRunnerProviderHeaders.forTurn({
    providerID,
    sessionID: "ses_test",
    parentID,
    promptCacheKey: "cache-key",
    messages,
  })

const oauth = Credential.OAuth.make({
  type: "oauth",
  access: "chatgpt-access",
  refresh: "chatgpt-refresh",
  expires: Date.now() + 60_000,
  methodID: Integration.MethodID.make("chatgpt-browser"),
  metadata: { accountID: "acct_1" },
})

describe("V2 provider request overrides", () => {
  it.effect("ChatGPT OAuth (Codex) carries the miao client identity and session affinity", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        catalog({ providerID: "openai", package: "@ai-sdk/openai" }),
        oauth,
      )
      const { wire, response } = yield* exchange(
        LLM.request({ model, prompt: "Hello", http: { headers: turnHeaders("openai") } }),
        responsesStream,
      )

      expect(wire.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(wire.headers).toMatchObject({
        authorization: "Bearer chatgpt-access",
        "chatgpt-account-id": "acct_1",
        originator: "miao",
        "session-id": "cache-key",
        "x-session-id": "ses_test",
        "x-session-affinity": "ses_test",
      })
      expect(wire.headers["user-agent"]).toStartWith(`miao/${InstallationVersion} (`)
      // V1 codex `chat.params` dropped maxOutputTokens; V2 never sends it.
      expect(wire.body).not.toHaveProperty("max_output_tokens")
      expect(wire.body).toMatchObject({ store: false, stream: true })
      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("OpenAI API keys keep the same client identity", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        catalog({ providerID: "openai", package: "@ai-sdk/openai" }),
        Credential.Key.make({ type: "key", key: "sk-test" }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)

      expect(wire.url).toBe("https://api.openai.com/v1/responses")
      expect(wire.headers).toMatchObject({ authorization: "Bearer sk-test", originator: "miao" })
      expect(wire.body).not.toHaveProperty("max_output_tokens")
    }),
  )

  it.effect("other @ai-sdk/openai providers do not claim the Codex originator", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        catalog({ providerID: "my-openai-proxy", package: "@ai-sdk/openai", url: "https://proxy.example/v1" }),
        Credential.Key.make({ type: "key", key: "sk-test" }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), responsesStream)

      expect(wire.headers).not.toHaveProperty("originator")
      expect(wire.headers).not.toHaveProperty("session-id")
    }),
  )

  it.effect("Cerebras omits max tokens unless the user configured them", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(
        catalog({ providerID: "cerebras", package: "@ai-sdk/cerebras", apiID: "gpt-oss-120b" }),
        Credential.Key.make({ type: "key", key: "csk-test" }),
      )
      const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), chatStream)

      expect(wire.url).toBe("https://api.cerebras.ai/v1/chat/completions")
      expect(wire.body).not.toHaveProperty("max_tokens")
      expect(wire.body).not.toHaveProperty("max_completion_tokens")
    }),
  )

  it.effect("Copilot turn headers mark initiator, interaction and vision", () =>
    Effect.sync(() => {
      expect(turnHeaders("github-copilot")).toMatchObject({
        "X-Interaction-Id": "ses_test",
        "x-initiator": "user",
      })
      expect(turnHeaders("github-copilot")).not.toHaveProperty("Copilot-Vision-Request")
      expect(turnHeaders("github-copilot")).not.toHaveProperty("session-id")
      // A subagent Session is agent-initiated even when its last message is a prompt.
      expect(turnHeaders("github-copilot", [Message.user("Hello")], "ses_parent")).toMatchObject({
        "x-initiator": "agent",
        "x-parent-session-id": "ses_parent",
      })
      // A tool continuation is agent-initiated.
      expect(
        turnHeaders("github-copilot", [
          Message.user("Hello"),
          Message.tool({ id: "call_1", name: "read", result: "ok", resultType: "text" }),
        ])["x-initiator"],
      ).toBe("agent")
      expect(
        turnHeaders("github-copilot", [
          Message.user([{ type: "media", mediaType: "image/png", data: "aGk=" }]),
        ])["Copilot-Vision-Request"],
      ).toBe("true")
      expect(
        turnHeaders("github-copilot", [
          Message.user("look"),
          Message.tool({
            id: "call_1",
            name: "read",
            result: { type: "content", value: [{ type: "file", uri: "data:image/png;base64,aGk=", mime: "image/png" }] },
          }),
        ])["Copilot-Vision-Request"],
      ).toBe("true")
    }),
  )

  it.effect("only OpenAI turns carry the Codex session-id cache header", () =>
    Effect.sync(() => {
      expect(turnHeaders("openai")["session-id"]).toBe("cache-key")
      expect(turnHeaders("anthropic")).toEqual({ "x-session-affinity": "ses_test", "X-Session-Id": "ses_test" })
    }),
  )
})
