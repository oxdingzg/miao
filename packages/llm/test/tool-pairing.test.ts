import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition, ToolResultPart, type ContentPart } from "../src"
import { OpenAIChat } from "../src/protocols"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

const tool = ToolDefinition.make({
  name: "bash",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
})

const reasoning = (text: string): ContentPart => ({ type: "reasoning", text }) as ContentPart
const call = (id: string) => ToolCallPart.make({ id, name: "bash", input: { command: "ls" } })
const result = (id: string, type: "text" | "json" | "content") =>
  ToolResultPart.make({
    id,
    name: "bash",
    result:
      type === "text"
        ? { type: "text", value: "ok" }
        : type === "json"
          ? { type: "json", value: { exitCode: 0, truncated: false } }
          : { type: "content", value: [{ type: "text", text: "ok" }] },
  })

// Mirrors the shape stored by the failing session: an assistant message that
// carries reasoning plus tool calls, followed by its results, twice.
const messages = [
  Message.user("检查两份合同"),
  Message.assistant([reasoning("先看看目录"), { type: "text", text: "我先看看" } as ContentPart, call("call_1"), call("call_2")]),
  Message.tool(result("call_1", "text")),
  Message.tool(result("call_2", "json")),
  Message.assistant([reasoning("继续"), call("call_3"), call("call_4")]),
  Message.tool(result("call_3", "content")),
  Message.tool(result("call_4", "json")),
  Message.assistant("好了"),
]

it.effect("wire messages keep every tool call paired", () =>
  Effect.gen(function* () {
    const route = OpenAIChat.route.with({
      endpoint: { baseURL: "https://api.deepseek.test/v1/" },
      auth: Auth.bearer("test"),
    })
    const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
      LLM.request({ id: "pairing", model: route.model({ id: "deepseek-chat" }), messages, tools: [tool] }),
    )
    const wire = prepared.body.messages as Array<Record<string, any>>
    console.log(
      "WIRE",
      JSON.stringify(
        wire.map((message) => ({
          role: message.role,
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.map((item: any) => item.id) : undefined,
          tool_call_id: message.tool_call_id,
          content: typeof message.content === "string" ? message.content.slice(0, 24) : message.content,
        })),
      ),
    )

    for (const [index, message] of wire.entries()) {
      const ids = Array.isArray(message.tool_calls) ? message.tool_calls.map((item: any) => item.id) : []
      if (ids.length === 0) continue
      const following = wire.slice(index + 1)
      for (const id of ids) {
        expect(following.some((item) => item.role === "tool" && item.tool_call_id === id)).toBe(true)
      }
      // The provider requires the tool messages to follow immediately.
      expect(following[0]?.role).not.toBe("assistant")
    }
  }),
)
