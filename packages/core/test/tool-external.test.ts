import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@miao/core/agent"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { Tool } from "@miao/core/tool/tool"

describe("Tool.makeExternal", () => {
  const context = {
    sessionID: SessionV2.ID.make("ses_external_tool"),
    agent: AgentV2.ID.make("build"),
    assistantMessageID: SessionMessage.ID.make("msg_external_tool"),
    toolCallID: "call-external",
  }

  test("exposes the raw JSON schema and returns text content", async () => {
    const tool = Tool.makeExternal({
      description: "Echo a query",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: (input) => Effect.succeed([{ type: "text", text: `echo:${String(input.query)}` }]),
    })

    const definition = Tool.definition("mcp__demo__echo", tool)
    expect(definition.name).toBe("mcp__demo__echo")
    expect(definition.description).toBe("Echo a query")
    expect(definition.inputSchema).toMatchObject({ type: "object" })

    const settlement = await Effect.runPromise(
      Tool.settle(tool, { type: "tool-call", id: "call-external", name: "mcp__demo__echo", input: { query: "hi" } }, context),
    )
    expect(settlement.content?.[0]).toMatchObject({ type: "text", text: "echo:hi" })
  })
})
