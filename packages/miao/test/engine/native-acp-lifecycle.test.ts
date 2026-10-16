import { expect, test } from "bun:test"
import path from "node:path"
import { ClientSideConnection, ndJsonStream, type Client, type SessionNotification } from "@agentclientprotocol/sdk"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

function textReply(text: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

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
  "SDK client walks the ACP lifecycle: authenticate, load replay, close idempotence, list, resume 404",
  async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "engine.db")
    const bodies: unknown[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        return textReply("lifecycle answer")
      },
    })
    try {
      let sessionId: string
      {
        const updates: SessionNotification[] = []
        await using agent = await connect(dbPath, tmp.path, provider.url.toString(), collector(updates))
        // The advertised authentication method authenticates; an unknown one is refused.
        await agent.connection.authenticate({ methodId: "miao-login" })
        const session = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
        sessionId = session.sessionId
        const reply = await agent.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: "lifecycle turn" }],
        })
        expect(reply.stopReason).toBe("end_turn")

      }

      // session/load replays the settled exchange exactly once.
      {
        const replayed: SessionNotification[] = []
        await using loader = await connect(dbPath, tmp.path, provider.url.toString(), collector(replayed))
        await loader.connection.loadSession?.({ sessionId, cwd: tmp.path, mcpServers: [] })
        const chunks = replayed
          .flatMap((event) => (event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : []))
          .join("")
        expect(chunks).toBe("lifecycle answer")
      }

      // Close is idempotent, the session still lists across processes, and
      // resuming an unknown identity is a client error rather than a creation.
      {
        const updates: SessionNotification[] = []
        await using agent = await connect(dbPath, tmp.path, provider.url.toString(), collector(updates))
        await agent.connection.closeSession?.({ sessionId })
        await agent.connection.closeSession?.({ sessionId })
        const sessions = await agent.connection.listSessions?.({})
        expect((sessions?.sessions ?? []).some((entry) => entry.sessionId === sessionId)).toBe(true)
        const missing = agent.connection.resumeSession({ sessionId: "ses_does_not_exist", cwd: tmp.path, mcpServers: [] })
        expect(missing).rejects.toThrow()
      }
      expect(bodies).toHaveLength(1)
    } finally {
      provider.stop(true)
    }
  },
  30_000,
)
