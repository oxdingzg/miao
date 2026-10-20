import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { AgentV2 } from "../src/agent"
import { PermissionV2 } from "../src/permission"
import { SessionMessage } from "../src/session/message"
import { PeerTools } from "../src/session/peer-tools"
import { SessionSchema } from "../src/session/schema"
import { Tool } from "../src/tool/tool"
import { AbsolutePath } from "../src/schema"

const senderID = SessionSchema.ID.make("ses_sender")
const targetID = SessionSchema.ID.make("ses_target")

const info = (id: typeof senderID, title: string): SessionSchema.Info =>
  ({
    id,
    projectID: "prj_test",
    title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/tmp") },
  }) as SessionSchema.Info

const sessions = new Map([
  [senderID, info(senderID, "Sender")],
  [targetID, info(targetID, "Target")],
])

const admitted: Array<{ sessionID: string; text: string; resume: boolean }> = []
const woke: string[] = []

const peers: PeerTools.Peers = {
  get: (id) => Effect.succeed(sessions.get(id)),
  list: (sender) =>
    Effect.succeed(
      [...sessions.values()]
        .filter((session) => session.id !== sender.id)
        .map((session) => ({
          id: session.id,
          slug: "target",
          title: session.title,
          parent_id: null,
          lastActivity: 10,
        })),
    ),
  resolve: (_sender, to) => Effect.succeed(sessions.get(SessionSchema.ID.make(to))),
  work: () =>
    Effect.succeed({
      execution: "busy" as const,
      task: "unfinished" as const,
      backgroundJobs: 1,
      objective: "finish the work",
      active: true,
    }),
  pending: () => Effect.succeed(0),
  admit: (input) =>
    Effect.sync(() => {
      admitted.push({ sessionID: input.sessionID, text: input.prompt.text, resume: input.resume })
    }),
  history: () => Effect.succeed([]),
  wake: (id) =>
    Effect.sync(() => {
      woke.push(id)
    }),
}

const tools = PeerTools.make({
  sessionID: senderID,
  permission: { assert: () => Effect.void } as unknown as PermissionV2.Interface,
  peers,
})

const context: Tool.Context = {
  sessionID: senderID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.create(),
  toolCallID: "call_1",
}

const settle = (name: string, input: unknown) => {
  const tool = tools[name]
  if (!tool) throw new Error(`missing tool ${name}`)
  return Effect.runPromise(
    Tool.settle(tool, { type: "tool-call", id: "call_1", name, input }, context),
  )
}

describe("peer tool factory", () => {
  test("exposes the three canonical definitions", () => {
    expect(Object.keys(tools).sort()).toEqual(["list_sessions", "read_session_context", "send_message"])
    const definition = Tool.definition("send_message", tools.send_message!)
    expect(definition.inputSchema).toMatchObject({
      type: "object",
      properties: { to: { type: "string" } },
    })
  })

  test("lists only active peers by default and reports engine work", async () => {
    const output = await settle("list_sessions", {})
    const text = output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    expect(text).toContain("ses_target")
    expect(text).toContain("execution: busy")
    expect(text).toContain("background jobs: 1")
  })

  test("admits a message and requests a wake for an active peer", async () => {
    const output = await settle("send_message", { to: targetID, message: "please continue" })
    expect(admitted).toEqual([
      {
        sessionID: targetID,
        text: expect.stringContaining("please continue"),
        resume: true,
      },
    ])
    expect(woke).toEqual([targetID])
    expect(output.structured).toMatchObject({ sessionID: targetID, wake: "requested" })
  })

  test("reports an empty peer transcript without inventing entries", async () => {
    const output = await settle("read_session_context", { session: targetID })
    const text = output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    expect(text).toContain("has no recorded messages")
  })
})
