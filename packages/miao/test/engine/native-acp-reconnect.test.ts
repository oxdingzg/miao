import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ClientSideConnection, ndJsonStream, type Client, type SessionNotification } from "@agentclientprotocol/sdk"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

function textReply(text: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

/** The published executable and the independent ACP SDK meet at stdio, not at
 * engine-internal helpers. `dbPath` lets a second client process attach to the
 * first client's journal — the acceptance matrix's reconnect row. */
async function connect(dbPath: string, directory: string, endpoint: string, client: Client) {
  if (!binary) throw new Error("MIAO_ENGINE_BIN is required")
  const child = Bun.spawn(
    [
      binary,
      "acp",
      "--db",
      dbPath,
      "--workspace",
      directory,
      "--provider",
      "openai-chat",
      "--model",
      "fixture",
      "--endpoint",
      endpoint,
    ],
    { env: { ...process.env, OPENAI_API_KEY: "fixture-only" }, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  )
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          child.stdin.write(chunk)
          await child.stdin.flush()
        },
        close() {
          child.stdin.end()
        },
      }),
      child.stdout,
    ),
  )
  try {
    await connection.initialize({ protocolVersion: 1, clientCapabilities: {} })
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  }
  return {
    connection,
    async [Symbol.asyncDispose]() {
      child.kill()
      await child.exited
    },
  }
}

function collector(updates: SessionNotification[]): Client {
  return {
    async requestPermission() {
      throw new Error("no permission expected in this matrix")
    },
    async sessionUpdate(update) {
      updates.push(update)
    },
  }
}

test.skipIf(!binary)(
  "SDK client reconnects across processes and the journal carries the conversation",
  async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "engine.db")
    const bodies: { messages?: { role: string; content: unknown }[] }[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        return textReply(`reconnect answer ${bodies.length}`)
      },
    })
    try {
      let sessionId: string
      {
        const updates: SessionNotification[] = []
        await using agent = await connect(dbPath, tmp.path, provider.url.toString(), collector(updates))
        const session = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
        sessionId = session.sessionId
        const reply = await agent.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: "turn one before reconnect" }],
        })
        expect(reply.stopReason).toBe("end_turn")
      }
      // First client process is disposed; the journal keeps the session.
      const db = new Database(dbPath, { readonly: true })
      const billed = db
        .query("SELECT count(*) AS count FROM engine_event WHERE kind='usage'")
        .get() as { count: number }
      db.close()
      expect(billed.count).toBe(1)

      // A second, independent client process resumes the same session id and
      // continues the conversation without replaying the first turn as new
      // output.
      const resumed: SessionNotification[] = []
      {
        await using agent = await connect(dbPath, tmp.path, provider.url.toString(), collector(resumed))
        await agent.connection.resumeSession({ sessionId, cwd: tmp.path, mcpServers: [] })
        const reply = await agent.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: "turn two after reconnect" }],
        })
        expect(reply.stopReason).toBe("end_turn")
      }
      const resumedText = resumed
        .flatMap((event) => (event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : []))
        .join("")
      expect(resumedText).toBe("reconnect answer 2")
      expect(bodies).toHaveLength(2)
      // The second provider call sees the full carried conversation.
      const contents = JSON.stringify(bodies[1]!.messages)
      expect(contents).toContain("turn one before reconnect")
      expect(contents).toContain("reconnect answer 1")
      expect(contents).toContain("turn two after reconnect")
      const after = new Database(dbPath, { readonly: true })
      const billedAfter = after
        .query("SELECT count(*) AS count FROM engine_event WHERE kind='usage'")
        .get() as { count: number }
      after.close()
      expect(billedAfter.count).toBe(2)
    } finally {
      provider.stop(true)
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "SDK client drives a long single-session conversation with accumulating context",
  async () => {
    await using tmp = await tmpdir()
    const bodies: { messages?: { role: string; content: unknown }[] }[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        return textReply(`long answer ${bodies.length}`)
      },
    })
    try {
      const updates: SessionNotification[] = []
      await using agent = await connect(
        path.join(tmp.path, "engine.db"),
        tmp.path,
        provider.url.toString(),
        collector(updates),
      )
      const session = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
      const turns = 8
      let lastText = ""
      for (let index = 1; index <= turns; index++) {
        const reply = await agent.connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: `long session turn ${index}` }],
        })
        expect(reply.stopReason).toBe("end_turn")
        lastText = `long answer ${index}`
      }
      // Every turn streamed its own settlement; the last one is the final text.
      expect(lastText).toBe("long answer 8")
      expect(bodies).toHaveLength(turns)
      // Context accumulates: each request carries every earlier exchange.
      const messageCounts = bodies.map((body) => body.messages?.length ?? 0)
      for (let index = 1; index < messageCounts.length; index++) expect(messageCounts[index]!).toBeGreaterThan(messageCounts[index - 1]!)
      // The final request carries every earlier exchange and the last
      // question; its own answer only exists after it.
      const final = JSON.stringify(bodies.at(-1)!.messages)
      for (let index = 1; index <= turns; index++) expect(final).toContain(`long session turn ${index}`)
      for (let index = 1; index < turns; index++) expect(final).toContain(`long answer ${index}`)
      const db = new Database(path.join(tmp.path, "engine.db"), { readonly: true })
      const billed = db
        .query("SELECT count(*) AS count FROM engine_event WHERE kind='usage'")
        .get() as { count: number }
      db.close()
      expect(billed.count).toBe(turns)
    } finally {
      provider.stop(true)
    }
  },
  60_000,
)
