import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message } from "../../src"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = OpenAIChat.route
  .with({
    provider: "github-copilot",
    endpoint: { baseURL: "https://copilot.test" },
    auth: Auth.bearer("fixture-only"),
  })
  .model({ id: "claude-sonnet-5.1" })
const chunk = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
})

it.effect(
  "Copilot interleaved reasoning retains separate spans and replays only the latest opaque with concatenated text",
  () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Inspect both files" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              chunk({ reasoning_text: "first", reasoning_opaque: "opaque-first" }),
              chunk({
                tool_calls: [
                  { index: 0, id: "call-one", type: "function", function: { name: "read", arguments: "{}" } },
                ],
              }),
              chunk({ reasoning_text: "second", reasoning_opaque: "opaque-second" }),
              chunk({ content: "checking" }),
              chunk({
                tool_calls: [
                  { index: 1, id: "call-two", type: "function", function: { name: "read", arguments: "{}" } },
                ],
              }),
              chunk({}, "tool_calls"),
            ),
          ),
        ),
      )
      expect(response.events.filter(LLMEvent.is.reasoningStart).map((event) => event.id)).toEqual([
        "reasoning-0",
        "reasoning-1",
      ])
      expect(response.message.content.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
        "first",
        "second",
      ])
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Inspect both files"),
            response.message,
            Message.tool({ id: "call-one", name: "read", result: { type: "text", value: "one" } }),
            Message.tool({ id: "call-two", name: "read", result: { type: "text", value: "two" } }),
          ],
        }),
      )
      const assistant = prepared.body.messages.find((message) => message.role === "assistant")
      expect(assistant).toMatchObject({ reasoning_text: "firstsecond", reasoning_opaque: "opaque-second" })
      expect(assistant).not.toHaveProperty("reasoning_content")
    }),
)

it.effect("opaque values arriving with text and tool calls remain replayable even without visible reasoning", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Read" })).pipe(
      Effect.provide(
        fixedResponse(
          sseEvents(
            chunk({ content: "reading", reasoning_opaque: "older" }),
            chunk({
              reasoning_opaque: "latest",
              tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
            }),
            chunk({}, "tool_calls"),
          ),
        ),
      ),
    )
    const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
      LLM.request({ model, messages: [response.message] }),
    )
    expect(prepared.body.messages[0]).toMatchObject({ content: "reading", reasoning_opaque: "latest" })
  }),
)
