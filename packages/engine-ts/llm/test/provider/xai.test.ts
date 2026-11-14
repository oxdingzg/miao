import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart } from "../../src"
import { XAI } from "../../src/providers"
import { OpenAIResponses } from "../../src/protocols/openai-responses"
import { OpenAIChat } from "../../src/protocols/openai-chat"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"

const messages = [
  Message.assistant([ToolCallPart.make({ id: "capture", name: "screenshot", input: {} })]),
  Message.tool({
    id: "capture",
    name: "screenshot",
    result: {
      type: "content",
      value: [
        { type: "text", text: "Screenshot result" },
        { type: "file", mime: "image/png", uri: "data:image/png;base64,cGl4ZWxz", name: "capture.png" },
        { type: "file", mime: "image/jpeg", uri: "data:image/jpeg;base64,aW1hZ2U=" },
      ],
    },
  }),
]

describe("XAI tool result images", () => {
  it.effect("the default Responses route preserves call ownership and ordered inline image output", () =>
    Effect.gen(function* () {
      const model = XAI.configure({ apiKey: "fixture-only" }).model("grok-4.3")
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(LLM.request({ model, messages }))
      expect(prepared.route).toBe("openai-responses")
      expect(prepared.body.input).toEqual([
        { type: "function_call", call_id: "capture", name: "screenshot", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "capture",
          output: [
            { type: "input_text", text: "Screenshot result" },
            { type: "input_image", image_url: "data:image/png;base64,cGl4ZWxz" },
            { type: "input_image", image_url: "data:image/jpeg;base64,aW1hZ2U=" },
          ],
        },
      ])
    }),
  )

  it.effect("the explicit Chat route retains tool text and lowers images into a following user message", () =>
    Effect.gen(function* () {
      const model = XAI.configure({ apiKey: "fixture-only" }).chat("grok-4.3")
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(LLM.request({ model, messages }))
      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body.messages).toMatchObject([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "capture", type: "function", function: { name: "screenshot", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "capture", content: "Screenshot result" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWxz" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" } },
          ],
        },
      ])
    }),
  )
})
