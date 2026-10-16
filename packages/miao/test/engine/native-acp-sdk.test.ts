import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import type { Client, SessionNotification } from "@agentclientprotocol/sdk"
import { connectNativeACP } from "./acp-client-fixture"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

function textReply(text: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

for (const decision of ["allow_once", "reject_once"] as const) {
  test.skipIf(!binary)(
    `published native ACP works with SDK permission ${decision}`,
    async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        path.join(tmp.path, "policy.json"),
        JSON.stringify({
          mode: "workspace",
          rules: [{ tool: "write_file", path: "**", decision: "ask" }],
        }),
      )
      const bodies: unknown[] = []
      const provider = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          bodies.push(await request.json())
          if (bodies.length > 1) return textReply("permission settled")
          return new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "sdk_write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "sdk.txt", text: "SDK approved", expected_sha256: null }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        const updates: SessionNotification[] = []
        const permissions: string[] = []
        await using agent = await connectNativeACP(tmp.path, provider.url.toString(), {
          async requestPermission(request) {
            const option = request.options.find((option) => option.kind === decision)
            if (!option) throw new Error(`missing permission option ${decision}`)
            permissions.push(option.optionId)
            return { outcome: { outcome: "selected", optionId: option.optionId } }
          },
          async sessionUpdate(update) {
            updates.push(update)
          },
        })
        const session = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
        const reply = await agent.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "write sdk.txt" }],
        })
        expect(reply.stopReason).toBe("end_turn")
        expect(permissions).toEqual([decision])
        expect(
          updates.some(
            (event) =>
              event.update.sessionUpdate === "agent_message_chunk" &&
              event.update.content.type === "text" &&
              event.update.content.text === "permission settled",
          ),
        ).toBe(true)
        expect(bodies).toHaveLength(2)
        expect(await Bun.file(path.join(tmp.path, "sdk.txt")).exists()).toBe(decision === "allow_once")
        if (decision === "allow_once")
          expect(await Bun.file(path.join(tmp.path, "sdk.txt")).text()).toBe("SDK approved")
        const db = new Database(path.join(tmp.path, "engine.db"), { readonly: true })
        try {
          expect(db.query("SELECT count(*) AS count FROM engine_event WHERE kind='tool.dispatched'").get()).toEqual({
            count: decision === "allow_once" ? 1 : 0,
          })
        } finally {
          db.close()
        }
      } finally {
        provider.stop(true)
      }
    },
    20_000,
  )
}

test.skipIf(!binary)(
  "published native ACP SDK cancels, recovers and resumes after process replacement",
  async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "policy.json"), "{}")
    const ready = Promise.withResolvers<void>()
    const bodies: unknown[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        if (bodies.length !== 1) return textReply(`answer ${bodies.length}`)
        ready.resolve()
        return new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const updates: SessionNotification[] = []
      const client: Client = {
        async requestPermission() {
          throw new Error("unexpected permission request")
        },
        async sessionUpdate(update) {
          updates.push(update)
        },
      }
      const sessionID = await (async () => {
        await using agent = await connectNativeACP(tmp.path, provider.url.toString(), client)
        const session = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
        const pending = agent.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hang this request" }],
        })
        await ready.promise
        await agent.connection.cancel({ sessionId: session.sessionId })
        expect((await pending).stopReason).toBe("cancelled")
        expect(bodies).toHaveLength(1)
        const recovered = await agent.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "recover this session" }],
        })
        expect(recovered.stopReason).toBe("end_turn")
        expect(bodies).toHaveLength(2)
        return session.sessionId
      })()
      updates.length = 0
      await using replacement = await connectNativeACP(tmp.path, provider.url.toString(), client)
      await replacement.connection.resumeSession({ sessionId: sessionID, cwd: tmp.path, mcpServers: [] })
      expect(updates.filter((event) => event.update.sessionUpdate === "agent_message_chunk")).toHaveLength(0)
      expect(
        (
          await replacement.connection.prompt({
            sessionId: sessionID,
            prompt: [{ type: "text", text: "after restart" }],
          })
        ).stopReason,
      ).toBe("end_turn")
      expect(JSON.stringify(bodies[2])).toContain("recover this session")
      expect(JSON.stringify(bodies[2])).toContain("answer 2")
      expect(JSON.stringify(bodies[2])).toContain("after restart")
    } finally {
      provider.stop(true)
    }
  },
  30_000,
)
