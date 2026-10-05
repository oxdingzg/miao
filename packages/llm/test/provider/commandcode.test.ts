import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, ToolCallPart } from "../../src"
import * as CommandCode from "../../src/protocols/commandcode"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"

const model = CommandCode.route
  .with({ endpoint: { baseURL: "https://api.commandcode.test" }, auth: Auth.bearer("test") })
  .model({ id: "deepseek/deepseek-v4-flash", provider: "commandcode" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const ndjson = (events: ReadonlyArray<unknown>) => events.map((event) => JSON.stringify(event)).join("\n") + "\n"

describe("Command Code route", () => {
  it.effect("prepares the /alpha/generate body", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CommandCode.CommandCodeBody>(request)
      expect(prepared.body.params.model).toBe("deepseek/deepseek-v4-flash")
      expect(prepared.body.params.stream).toBe(true)
      expect(prepared.body.params.max_tokens).toBe(20)
      expect(prepared.body.params.temperature).toBe(0)
      expect(prepared.body.params.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Say hello." }] },
      ])
      expect(prepared.body.params.system).toEqual([{ type: "text", text: "You are concise." }])
      expect(prepared.body.permissionMode).toBe("standard")
      expect(prepared.body.memory).toBeNull()
      expect(prepared.body.taste).toBeNull()
    }),
  )

  it.effect("parses text, reasoning, and usage from the AI SDK full stream", () =>
    Effect.gen(function* () {
      const body = ndjson([
        { type: "start" },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "think" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", text: "Hi" },
        { type: "text-delta", id: "txt-0", text: " there" },
        { type: "text-end", id: "txt-0" },
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 42, outputTokens: 37, totalTokens: 79 },
        },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 42,
            inputTokenDetails: { noCacheTokens: 42, cacheReadTokens: 0 },
            outputTokens: 37,
            outputTokenDetails: { reasoningTokens: 33 },
            totalTokens: 79,
          },
        },
        { type: "provider-metadata", providerMetadata: {} },
      ])
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.text).toBe("Hi there")
      expect(response.reasoning).toBe("think")
      expect(response.finishReason).toBe("stop")
      expect(response.usage?.inputTokens).toBe(42)
      expect(response.usage?.outputTokens).toBe(37)
      expect(response.usage?.reasoningTokens).toBe(33)
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
    }),
  )

  it.effect("parses tool calls and maps tool-call finish to tool-calls", () =>
    Effect.gen(function* () {
      const body = ndjson([
        { type: "start" },
        { type: "text-start", id: "txt-0" },
        { type: "tool-input-start", id: "call_1", toolName: "get_weather" },
        { type: "tool-input-delta", id: "call_1", delta: '{"city":"Paris"}' },
        { type: "tool-input-end", id: "call_1" },
        { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Paris" } },
        { type: "text-end", id: "txt-0" },
        { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.finishReason).toBe("tool-calls")
      expect(response.toolCalls).toHaveLength(1)
      expect(response.toolCalls[0]?.name).toBe("get_weather")
      expect(response.toolCalls[0]?.input).toEqual({ city: "Paris" })
    }),
  )

  it.effect("surfaces a provider-error event as a stream failure", () =>
    Effect.gen(function* () {
      const body = ndjson([{ type: "start" }, { type: "error", error: { message: "rate limited", type: "rate_limit" } }])
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)
      expect(String(error)).toContain("rate limited")
    }),
  )

  it.effect("lowers assistant tool-call and tool-result history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CommandCode.CommandCodeBody>(
        LLM.request({
          model,
          messages: [
            Message.user("weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Paris" } })]),
            Message.tool({ id: "call_1", name: "get_weather", result: { temp: 20 } }),
          ],
        }),
      )
      expect(prepared.body.params.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Paris" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "get_weather",
              output: { type: "text", value: '{"temp":20}' },
            },
          ],
        },
      ])
    }),
  )

  it.effect("streams events incrementally", () =>
    Effect.gen(function* () {
      const body = ndjson([
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", text: "a" },
        { type: "text-delta", id: "txt-0", text: "b" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 2 } },
      ])
      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      expect(events.filter(LLMEvent.is.textDelta).map((event) => event.text)).toEqual(["a", "b"])
    }),
  )
})
