import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { GoogleAccount } from "@miao/core/google-account"
import { modelFetch, models, toolSchema } from "@miao/core/google-account/transport"
import { ProviderGateway } from "@miao/core/provider-gateway"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { EventV2 } from "@miao/core/event"
import { Catalog } from "@miao/core/catalog"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { PluginV2 } from "@miao/core/plugin"
import { createGoogleAccountPlugin } from "@miao/core/plugin/provider/google-account"
import { PluginTestLayer } from "./plugin/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const modelID = "gemini-3-fixture"
const fixture = Effect.fn("GoogleAccount.transportFixture")(function* () {
  let signalAbort: () => void = () => {}
  const aborted = new Promise<void>((resolve) => { signalAbort = resolve })
  const state = { mode: "text", status: 200, reason: undefined as string | undefined, retry: undefined as string | undefined, reset: undefined as string | undefined, calls: [] as Array<{ auth: string | null; key: string | null; body: unknown }> }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body: unknown = await request.json()
      state.calls.push({ auth: request.headers.get("authorization"), key: request.headers.get("x-goog-api-key"), body })
      if (state.status !== 200) return Response.json({ error: { message: "fixture-private-token-must-not-leak", details: state.reason ? [{ reason: state.reason, metadata: { quotaResetDelay: state.reset } }] : [] } }, { status: state.status, headers: state.retry ? { "retry-after": state.retry } : {} })
      if (path === "/v1internal:fetchAvailableModels") return Response.json({ models: {
        [modelID]: { displayName: "Fixture Gemini", maxTokens: 12345, maxOutputTokens: 4096, supportsImages: true },
        "gemini-disabled": { disabled: true }, "gemini-unselectable": { selectable: false }, "other-model": {},
      } })
      if (path !== "/v1internal:streamGenerateContent" && path !== "/v1internal:generateContent") return new Response(null, { status: 404 })
      const followup = JSON.stringify(body).includes("functionResponse")
      const parts = state.mode === "tool" && !followup
        ? [{ functionCall: { name: "echo", args: { text: "hello" } }, thoughtSignature: "fixture-real-thought-signature" }]
        : state.mode === "reasoning" ? [{ text: "Checking the relevant files", thought: true }, { text: "你好 Gemini" }] : [{ text: "你好 Gemini" }]
      const data = { candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13, cachedContentTokenCount: 2 }, modelVersion: modelID }
      if (path.endsWith(":generateContent")) return Response.json({ response: data })
      const frame = new TextEncoder().encode(`data: ${JSON.stringify({ response: data })}\r\n\r\n`)
      if (state.mode === "hang") return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", signalAbort, { once: true })
          controller.enqueue(frame)
        },
        cancel() { signalAbort() },
      }), { headers: { "content-type": "text/event-stream" } })
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < frame.length; i += 7) {
            controller.enqueue(frame.slice(i, i + 7))
            await Bun.sleep(1)
          }
          controller.close()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  return { state, aborted, options: { ...GoogleAccount.defaults, baseURL: server.url.toString().replace(/\/$/, ""), userAgent: "miao-fixture" } }
})

it.live("Google account discovers only callable Gemini models without inventing aliases", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  const found = yield* Effect.promise(() => models("fixture-access", "project-one", options))
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({ id: modelID, maxTokens: 12345, supportsImages: true })
  expect(state.calls[0]).toMatchObject({ auth: "Bearer fixture-access", key: null, body: { project: "project-one" } })
}))

it.live("Google model transport wraps the correct project and unwraps split UTF-8 stream frames", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  const send = modelFetch("fixture-access", "project-one", options)
  const response = yield* Effect.promise(() => send(`https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "x-goog-api-key": "must-not-forward" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "system" }] } }),
  }))
  const text = yield* Effect.promise(() => response.text())
  expect(text).toContain("你好 Gemini")
  expect(text).not.toContain('"response":')
  expect(state.calls[0]).toMatchObject({ auth: "Bearer fixture-access", key: null, body: { model: modelID, project: "project-one", requestType: "agent", request: { systemInstruction: { role: "user" } } } })
}))

it.live("quota/authentication failures do not leak upstream token descriptions", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  state.status = 429
  const error = yield* Effect.tryPromise({ try: () => modelFetch("fixture-access", "project-one", options)(`https://example.test/models/${modelID}:generateContent`, { method: "POST", body: "{}" }), catch: (cause) => cause }).pipe(Effect.flip)
  expect(String(error)).toContain("HTTP 429")
  expect(String(error)).not.toContain("account quota is exhausted")
  expect(String(error)).not.toContain("fixture-private-token-must-not-leak")
}))

it.live("the actual Google SDK bridge preserves tool-call signatures across the next turn", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  state.mode = "tool"
  const sdk = createGoogleGenerativeAI({ apiKey: "fixture-sentinel", fetch: modelFetch("fixture-access", "project-one", options) })
  const cache = new Map<string, string>()
  const signatures = { get: (id: string) => cache.get(id), set: (id: string, value: string) => { cache.set(id, value) } }
  const first = yield* Effect.promise(() => ProviderGateway.reply(sdk.languageModel(modelID), {
    model: modelID, messages: [{ role: "user", content: "Echo hello using the tool" }],
    tools: [{ type: "function", function: { name: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } } }],
  }, null, modelID, signatures))
  const text = yield* Effect.promise(() => first.text())
  expect(text).toContain("tool_calls")
  expect(text).toContain('"name":"echo"')
  expect(cache.size).toBe(1)
  const id = cache.keys().next().value
  if (!id) throw new Error("tool-call signature not captured")
  expect(cache.get(id)).toBe("fixture-real-thought-signature")
  const second = yield* Effect.promise(() => ProviderGateway.reply(sdk.languageModel(modelID), {
    model: modelID, messages: [
      { role: "user", content: "Echo hello using the tool" },
      { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "echo", arguments: '{"text":"hello"}' } }] },
      { role: "tool", tool_call_id: id, content: "hello" },
    ],
  }, null, modelID, signatures))
  expect(yield* Effect.promise(() => second.text())).toContain("你好 Gemini")
  expect(JSON.stringify(state.calls.at(-1)?.body)).toContain("fixture-real-thought-signature")
  expect(state.calls[0].body).toMatchObject({ request: { tools: [{ functionDeclarations: [{ name: "echo", parameters: { type: "OBJECT" } }] }] } })
}))

it.live("cancelling the client reply closes the actual upstream generation request", () => Effect.gen(function* () {
  const { state, options, aborted } = yield* fixture()
  state.mode = "hang"
  const sdk = createGoogleGenerativeAI({ apiKey: "fixture-sentinel", fetch: modelFetch("fixture-access", "project-one", options) })
  const response = yield* Effect.promise(() => ProviderGateway.reply(sdk.languageModel(modelID), { model: modelID, messages: [{ role: "user", content: "hello" }] }, null, modelID))
  const reader = response.body?.getReader()
  if (!reader) throw new Error("missing response stream")
  yield* Effect.promise(() => reader.read())
  yield* Effect.promise(() => reader.cancel("client interrupted"))
  const result = yield* Effect.promise(() => Promise.race([aborted.then(() => "closed"), Bun.sleep(3000).then(() => "timeout")]))
  expect(result).toBe("closed")
}))

test("Google tool schemas resolve local refs without losing property names", () => {
  const schema = { type: "object", $defs: { Name: { type: "string" } }, properties: { additionalProperties: { $ref: "#/$defs/Name" }, values: { type: "array", items: { type: ["string", "null"] } } }, required: ["additionalProperties"], additionalProperties: false }
  expect(toolSchema(schema)).toEqual({ type: "OBJECT", properties: { additionalProperties: { type: "STRING" }, values: { type: "ARRAY", items: { type: "STRING", nullable: true } } }, required: ["additionalProperties"] })
  expect(() => toolSchema({ $ref: "https://other.example.test/schema" })).toThrow("finite local")
  expect(() => toolSchema({ $ref: "#/$defs/Cycle", $defs: { Cycle: { $ref: "#/$defs/Cycle" } } })).toThrow("finite local")
})

const plugins = testEffect(PluginTestLayer)
plugins.live("real provider registration keeps API-key Google separate and routes the selected OAuth account", () => Effect.gen(function* () {
  const registry = yield* PluginV2.Service
  const credentials = yield* Credential.Service
  const integration = yield* Integration.Service
  const events = yield* EventV2.Service
  const catalog = yield* Catalog.Service
  const { state, options } = yield* fixture()
  yield* catalog.transform((draft) => {
    draft.model.update(ProviderV2.ID.make(GoogleAccount.providerID), ModelV2.ID.make("gemini-api-key-only"), (model) => {
      model.api = { type: "aisdk", package: "@ai-sdk/google", id: model.id }
      model.enabled = true
      model.capabilities.tools = true
      model.capabilities.output = ["text"]
    })
  })
  const implementation = createGoogleAccountPlugin(options)
  yield* registry.add(PluginV2.ID.make("google-account-fixture"), (ctx) => implementation.effect(ctx).pipe(
    Effect.provideService(Credential.Service, credentials), Effect.provideService(Integration.Service, integration), Effect.provideService(EventV2.Service, events),
  ))
  const id = Integration.ID.make(GoogleAccount.providerID)
  const info = yield* integration.get(id)
  expect(info?.methods.map((method) => method.type)).toEqual(["oauth", "oauth"])
  expect(yield* catalog.model.available()).toHaveLength(0)
  const first = yield* credentials.create({ integrationID: id, label: "First", value: Credential.OAuth.make({ type: "oauth", methodID: GoogleAccount.browserMethodID, access: "first-access", refresh: "first-refresh", expires: Date.now() + 3600_000, metadata: { projectID: "project-first" } }) })
  yield* credentials.create({ integrationID: id, label: "Second", value: Credential.OAuth.make({ type: "oauth", methodID: GoogleAccount.browserMethodID, access: "second-access", refresh: "second-refresh", expires: Date.now() + 3600_000, metadata: { projectID: "project-second" } }) })
  yield* catalog.reload()
  const model = yield* catalog.model.get(ProviderV2.ID.make(GoogleAccount.providerID), ModelV2.ID.make(modelID))
  if (model?.api.type !== "aisdk" || !model.api.url) throw new Error("OAuth model did not appear")
  expect(model.limit.context).toBe(12345)
  expect(yield* catalog.model.getAvailable(ProviderV2.ID.make(GoogleAccount.providerID), ModelV2.ID.make("gemini-api-key-only"))).toBeUndefined()
  expect((yield* catalog.model.available()).map((model) => model.id)).toEqual([ModelV2.ID.make(modelID)])
  const before = state.calls.length
  const invalid = yield* Effect.promise(() => fetch(`${model.api.url}/chat/completions`, { method: "POST", headers: { Authorization: "Bearer unregistered" }, body: JSON.stringify({ model: modelID, messages: [] }) }))
  expect(invalid.status).toBe(401)
  expect(state.calls).toHaveLength(before)
  const result = yield* Effect.promise(() => fetch(`${model.api.url}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${first.value.type === "oauth" ? first.value.access : ""}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: modelID, stream: true, messages: [{ role: "user", content: "hello" }] }) }))
  expect(result.status).toBe(200)
  expect(yield* Effect.promise(() => result.text())).toContain("你好 Gemini")
  expect(state.calls.at(-1)).toMatchObject({ auth: "Bearer first-access", body: { project: "project-first" } })
  const key = yield* credentials.create({ integrationID: id, label: "API key", value: Credential.Key.make({ type: "key", key: "key-fixture" }) })
  yield* credentials.activate(key.id)
  yield* catalog.reload()
  expect((yield* catalog.model.available()).map((model) => model.id)).toEqual([ModelV2.ID.make("gemini-api-key-only")])
}))


test("parallel Gemini tool history attaches a signature only to its first function call", () => {
  const result = ProviderGateway.toModelMessages([{role:"assistant",tool_calls:[
    {id:"first",type:"function",function:{name:"echo",arguments:"{}"}},
    {id:"second",type:"function",function:{name:"echo",arguments:"{}"}},
  ]}], {get:()=>"fixture-signature",set:()=>{}})
  expect(JSON.stringify(result.conversation).match(/thoughtSignature/g)).toHaveLength(1)
  expect(result.conversation[0]).toMatchObject({content:[
    {type:"tool-call",toolCallId:"first",providerOptions:{google:{thoughtSignature:"fixture-signature"}}},
    {type:"tool-call",toolCallId:"second"},
  ]})
})

it.live("Google thought summaries reach the actual chat bridge and explicit opt-outs are preserved", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    state.mode = "reasoning"
    const send = modelFetch("fixture-access", "project-one", options)
    const sdk = createGoogleGenerativeAI({ apiKey: "fixture-sentinel", fetch: send })
    const response = yield* Effect.promise(() =>
      ProviderGateway.reply(
        sdk.languageModel(modelID),
        { model: modelID, messages: [{ role: "user", content: "hello" }] },
        null,
        modelID,
      ),
    )
    const text = yield* Effect.promise(() => response.text())
    expect(text).toContain('"reasoning_content":"Checking the relevant files"')
    expect(text).toContain("你好 Gemini")
    expect(state.calls[0].body).toMatchObject({
      request: { generationConfig: { thinkingConfig: { includeThoughts: true } } },
    })
    yield* Effect.promise(() =>
      send(`https://example.test/models/${modelID}:generateContent`, {
        method: "POST",
        body: JSON.stringify({
          generationConfig: { temperature: 0.5, thinkingConfig: { includeThoughts: false, thinkingBudget: 128 } },
        }),
      }),
    )
    expect(state.calls.at(-1)?.body).toMatchObject({
      request: {
        generationConfig: { temperature: 0.5, thinkingConfig: { includeThoughts: false, thinkingBudget: 128 } },
      },
    })
  }),
)

it.live("the SDK gateway preserves rate-limit evidence without hidden retries", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    state.status = 429
    state.reason = "RATE_LIMIT_EXCEEDED"
    state.retry = "2"
    const sdk = createGoogleGenerativeAI({
      apiKey: "fixture-sentinel",
      fetch: modelFetch("fixture-access", "project-one", options),
    })
    const response = yield* Effect.promise(() =>
      ProviderGateway.reply(
        sdk.languageModel(modelID),
        {
          model: modelID,
          messages: [{ role: "user", content: "hello" }],
        },
        null,
        modelID,
      ),
    )
    const text = yield* Effect.promise(() => response.text())
    expect(state.calls).toHaveLength(1)
    expect(text).toContain('"status":429')
    expect(text).toContain("RATE_LIMIT_EXCEEDED")
    expect(text).toContain("Retry after 2 seconds")
    expect(text).not.toContain("fixture-private-token-must-not-leak")
    expect(text).not.toContain("account quota is exhausted")
  }),
)

it.live("temporary capacity and service quotas remain distinguishable", () =>
  Effect.gen(function* () {
    for (const [reason, expected] of [
      ["MODEL_CAPACITY_EXHAUSTED", "insufficient capacity"],
      ["QUOTA_EXCEEDED", "quota for this service or model"],
    ]) {
      const { state, options } = yield* fixture()
      state.status = 429
      state.reason = reason
      const error = yield* Effect.tryPromise({
        try: () =>
          modelFetch(
            "fixture-access",
            "project-one",
            options,
          )(`https://example.test/models/${modelID}:generateContent`, { method: "POST", body: "{}" }),
        catch: (cause) => cause,
      }).pipe(Effect.flip)
      expect(String(error)).toContain(expected)
      expect(String(error)).not.toContain("fixture-private-token-must-not-leak")
    }
  }),
)


it.live("service quota reset delays are retained without raw provider descriptions", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  state.status = 429
  state.reason = "QUOTA_EXHAUSTED"
  state.reset = "12.5s"
  const error = yield* Effect.tryPromise({ try: () => modelFetch("fixture-access", "project-one", options)(`https://example.test/models/${modelID}:generateContent`, { method: "POST", body: "{}" }), catch: (cause) => cause }).pipe(Effect.flip)
  expect(error).toBeInstanceOf(GoogleAccount.RequestError)
  expect(String(error)).toContain("Retry after 13 seconds")
  expect(String(error)).not.toContain("fixture-private-token-must-not-leak")
}))


it.live("weekly reset hints are not dropped by a one-day delay cap", () => Effect.gen(function* () {
  const { state, options } = yield* fixture()
  state.status = 429
  state.reason = "QUOTA_EXHAUSTED"
  state.reset = "518400s"
  const error = yield* Effect.tryPromise({ try: () => modelFetch("fixture-access", "project-one", options)(`https://example.test/models/${modelID}:generateContent`, { method: "POST", body: "{}" }), catch: (cause) => cause }).pipe(Effect.flip)
  expect(error).toBeInstanceOf(GoogleAccount.RequestError)
  expect((error as GoogleAccount.RequestError).retryAfterMs).toBe(518400000)
  expect(String(error)).toMatch(/Retry after \d{4}-\d{2}-\d{2}T/)
}))
