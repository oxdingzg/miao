import { describe, expect } from "bun:test"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LLM, LLMResponse } from "../src"
import { Auth, LLMClient, ProviderWireArchive } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { it } from "./lib/effect"
import { scriptedResponses } from "./lib/http"
import { deltaChunk, finishChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const request = LLM.request({ id: "req_1", model, prompt: "Archive me." })

/** Only the fields this test asserts on; the archive keeps the whole body. */
const SentBody = Schema.Struct({
  model: Schema.String,
  stream: Schema.Boolean,
  messages: Schema.Array(Schema.Unknown),
})
const decodeSentBody = Schema.decodeUnknownSync(Schema.fromJsonString(SentBody))

const body = sseEvents(deltaChunk({ role: "assistant", content: "Done." }), finishChunk("stop"))

describe("ProviderWireArchive", () => {
  it.effect("records one exchange across the request, response, and frames", () =>
    Effect.gen(function* () {
      const lines = yield* Ref.make<ReadonlyArray<ProviderWireArchive.Line>>([])
      const archive = ProviderWireArchive.layerOf((line) => Ref.update(lines, (all) => [...all, line]))
      // Provided to the layer build only, never to the effect's own environment:
      // a deployment hands the archive to the client, not to every request.
      const layer = scriptedResponses([body]).pipe(Layer.provide(archive))

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(layer)),
      )
      expect(events.length).toBeGreaterThan(0)

      const recorded = yield* Ref.get(lines)
      const exchanges = new Set(recorded.map((line) => line.exchange))
      expect(exchanges.size).toBe(1)

      const requests = recorded.filter((line) => line.kind === "request")
      const responses = recorded.filter((line) => line.kind === "response")
      const frames = recorded.filter((line) => line.kind === "frame")

      expect(requests).toHaveLength(1)
      expect(responses).toHaveLength(1)
      expect(frames.length).toBeGreaterThanOrEqual(2)
      expect(recorded.every((line) => line.route === "openai-chat")).toBe(true)

      const sent = requests[0]
      expect(sent.method).toBe("POST")
      expect(sent.url).toBe("https://api.openai.test/v1/chat/completions")
      expect(sent.headers["authorization"]).toBe("<redacted>")
      expect(sent.body).toBeDefined()

      const sentBody = decodeSentBody(sent.body ?? "")
      expect(sentBody.model).toBe("gpt-4o-mini")
      expect(sentBody.stream).toBe(true)
      expect(sentBody.messages).toHaveLength(1)

      expect(responses[0].status).toBe(200)
      expect(responses[0].attempt).toBe(sent.attempt)

      const frameTexts = frames.map((frame) => frame.text)
      expect(frameTexts).toContain(JSON.stringify(deltaChunk({ role: "assistant", content: "Done." })))
      expect(frameTexts).toContain(JSON.stringify(finishChunk("stop")))
    }),
  )

  it.effect("streams normally when the host provides no archive", () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(scriptedResponses([body]))),
      )

      expect(LLMResponse.text({ events })).toBe("Done.")
    }),
  )
})
