import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import { OpenAIResponses, type OpenAIResponsesBody } from "../../src/protocols/openai-responses"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { it } from "../lib/effect"

const endpoint = "https://cache.test/v1/responses"
const route = OpenAIResponses.route.with({ endpoint: { baseURL: "https://cache.test/v1" } })
const model = (profile: "legacy" | "breakpoints", boundEndpoint = endpoint, id = "cache-model") =>
  route.model({ id, compatibility: { responsesCache: { profile, endpoint: boundEndpoint, model: "cache-model" } } })
const request = (selected = model("breakpoints")) =>
  LLM.request({ id: "cache-request", model: selected, system: "stable rules", prompt: "question" })

const prepare = (input: ReturnType<typeof request>) => LLMClient.prepare<OpenAIResponsesBody>(input)

describe("Responses cache capability contract", () => {
  it.effect("preserves undeclared endpoint behavior and never infers capabilities from names", () =>
    Effect.gen(function* () {
      const input = request(route.model({ id: "future-cache-model" }))
      const prepared = yield* prepare(input)
      expect(prepared.body.input[0]).toEqual({ role: "system", content: "stable rules" })
      expect(prepared.body).not.toHaveProperty("prompt_cache_options")
      expect(prepared.body).not.toHaveProperty("prompt_cache_retention")
      const rejected = yield* prepare(
        LLM.updateRequest(input, {
          providerOptions: { openai: { promptCacheOptions: { mode: "implicit" } } },
        }),
      ).pipe(Effect.flip)
      expect(rejected.message).toContain("explicit breakpoint-capable deployment")
    }),
  )

  it.effect("marks only the stable system prefix while preserving implicit tail caching", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare(request())
      expect(prepared.body.prompt_cache_options).toEqual({ mode: "implicit" })
      expect(prepared.body.input[0]).toEqual({
        role: "developer",
        content: [{ type: "input_text", text: "stable rules", prompt_cache_breakpoint: { mode: "explicit" } }],
      })
      expect(prepared.body.input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "question" }] })
      expect(prepared.body).not.toHaveProperty("prompt_cache_retention")
    }),
  )

  it.effect("binds declarations to model and complete endpoint before transport", () =>
    Effect.gen(function* () {
      for (const selected of [
        model("breakpoints", "https://other.test/v1/responses"),
        model("breakpoints", endpoint, "other-model"),
      ]) {
        const rejected = yield* prepare(request(selected)).pipe(Effect.flip)
        expect(rejected.message).toContain("does not match")
      }
      const wrongRoute = OpenAIChat.route.model({
        id: "cache-model",
        compatibility: { responsesCache: { profile: "breakpoints", endpoint, model: "cache-model" } },
      })
      const rejected = yield* LLMClient.prepare(request(wrongRoute)).pipe(Effect.flip)
      expect(rejected.message).toContain("does not match")
      for (const http of [
        { query: { "api-version": "changed" } },
        { body: { model: "other-model" } },
        { body: { input: [] } },
        { body: { prompt_cache_options: { mode: "implicit" } } },
      ]) {
        const error = yield* prepare(LLM.updateRequest(request(), { http })).pipe(Effect.flip)
        expect(error.message.length).toBeGreaterThan(0)
      }
    }),
  )

  it.effect("keeps legacy retention separate from modern options and validates TTL", () =>
    Effect.gen(function* () {
      const legacy = yield* prepare(
        LLM.updateRequest(request(model("legacy")), {
          providerOptions: { openai: { promptCacheRetention: "24h" } },
        }),
      )
      expect(legacy.body.prompt_cache_retention).toBe("24h")
      expect(legacy.body.input[0]).toEqual({ role: "system", content: "stable rules" })
      expect(legacy.body).not.toHaveProperty("prompt_cache_options")
      const modern = yield* prepare(
        LLM.updateRequest(request(), {
          providerOptions: { openai: { promptCacheOptions: { ttl: "30m", mode: "explicit" } } },
        }),
      )
      expect(modern.body.prompt_cache_options).toEqual({ ttl: "30m", mode: "explicit" })
      for (const input of [
        LLM.updateRequest(request(), { providerOptions: { openai: { promptCacheRetention: "24h" } } }),
        LLM.updateRequest(request(model("legacy")), {
          providerOptions: { openai: { promptCacheOptions: { mode: "implicit" } } },
        }),
        LLM.updateRequest(request(), { cache: { ttlSeconds: 300 } }),
        LLM.updateRequest(request(), { providerOptions: { openai: { promptCacheOptions: { ttl: "1h" } } } }),
      ]) {
        const error = yield* prepare(input).pipe(Effect.flip)
        expect(error.message.length).toBeGreaterThan(0)
      }
    }),
  )

  it.effect("requires real breakpoints for explicit mode and rejects contradictory prewarming", () =>
    Effect.gen(function* () {
      const disabled = yield* prepare(LLM.updateRequest(request(), { cache: "none" }))
      expect(disabled.body.prompt_cache_options).toEqual({ mode: "explicit" })
      expect(disabled.body.input[0]).toEqual({ role: "system", content: "stable rules" })
      const prewarm = yield* prepare(
        LLM.updateRequest(request(), {
          providerOptions: { openai: { promptCacheOptions: { prewarm: true } } },
        }),
      )
      expect(prewarm.body.prompt_cache_options).toEqual({ mode: "implicit", prewarm: true })
      for (const input of [
        LLM.updateRequest(request(), {
          cache: "none",
          providerOptions: { openai: { promptCacheOptions: { prewarm: true } } },
        }),
        LLM.updateRequest(request(), {
          system: [],
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit" } } },
        }),
      ]) {
        const error = yield* prepare(input).pipe(Effect.flip)
        expect(error.message.length).toBeGreaterThan(0)
      }
    }),
  )

  it.effect("shares the same bound contract for HTTP and WebSocket lowering", () =>
    Effect.gen(function* () {
      const socket = OpenAIResponses.webSocketRoute.with({ endpoint: { baseURL: "https://cache.test/v1" } }).model({
        id: "cache-model",
        compatibility: { responsesCache: { profile: "breakpoints", endpoint, model: "cache-model" } },
      })
      const http = yield* prepare(request())
      const ws = yield* prepare(request(socket))
      expect(ws.body).toEqual(http.body)
      const alias = route
        .with({
          id: "custom-cache-route",
          endpoint: { path: ({ body }) => (body.model === "cache-model" ? "/responses" : "/invalid") },
        })
        .model({
          id: "cache-model",
          compatibility: { responsesCache: { profile: "breakpoints", endpoint, model: "cache-model" } },
        })
      expect((yield* prepare(request(alias))).body).toEqual(http.body)
    }),
  )
})
