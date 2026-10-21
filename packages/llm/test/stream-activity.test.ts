import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM } from "../src"
import { LLMClient } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { fixedResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"
import { it } from "./lib/effect"

describe("provider stream activity", () => {
  it.effect("reports request size, response headers, and response bytes", () =>
    Effect.gen(function* () {
      const activity = { headers: 0, bytes: 0, requestBytes: 0 }
      const request = LLM.request({
        model: OpenAIChat.route.model({ id: "gpt-4o-mini" }),
        prompt: "Say hello.",
      })
      const events = yield* LLMClient.stream(request, {
        activity: {
          headers: () => activity.headers++,
          bytes: (count) => {
            activity.bytes += count
          },
          requestBytes: (count) => {
            activity.requestBytes = count
          },
        },
      }).pipe(
        Stream.runCollect,
        Effect.provide(fixedResponse(sseEvents(deltaChunk({ content: "Hello" }), deltaChunk({}, "stop")))),
      )

      expect(events.length).toBeGreaterThan(0)
      expect(activity.headers).toBe(1)
      expect(activity.requestBytes).toBeGreaterThan(0)
      expect(activity.bytes).toBeGreaterThan(0)
    }),
  )
})
