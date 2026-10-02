// Drives the V2 ACP adapter in this process through the ACP SDK's own client
// connection, against a real `miao serve` subprocess. Nothing here opens an
// editor; the "client" records what an editor would be sent.
import {
  ClientSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk"
import { serve } from "@miao/acp"
import { OpenCode } from "@miao/client"
import { Effect } from "effect"

export type Answer = (request: RequestPermissionRequest) => RequestPermissionResponse

export const allowOnce: Answer = () => ({ outcome: { outcome: "selected", optionId: "once" } })
export const reject: Answer = () => ({ outcome: { outcome: "selected", optionId: "reject" } })

/** One editor connection. Closed when the surrounding test scope ends. */
export function connect(url: string) {
  return Effect.gen(function* () {
    const toAgent = pipe()
    const toClient = pipe()
    const logs: string[] = []
    serve({
      client: OpenCode.make({ baseUrl: url }),
      version: "test",
      output: toClient.writable,
      input: toAgent.readable,
      log: (message) => logs.push(message),
    })
    const updates: SessionNotification[] = []
    const permissions: RequestPermissionRequest[] = []
    const writes: WriteTextFileRequest[] = []
    const policy = { answer: allowOnce }
    const conn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (notification) => {
          updates.push(notification)
        },
        requestPermission: async (request) => {
          permissions.push(request)
          return policy.answer(request)
        },
        writeTextFile: async (request) => {
          writes.push(request)
          return {}
        },
        readTextFile: async () => ({ content: "" }),
      }),
      ndJsonStream(toAgent.writable, toClient.readable),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        toAgent.end()
        toClient.end()
      }),
    )
    yield* Effect.promise(() =>
      conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
    )
    return {
      conn,
      updates,
      permissions,
      writes,
      logs,
      policy,
      /** Updates of one kind for one session. */
      of: <T extends SessionNotification["update"]["sessionUpdate"]>(sessionId: string, kind: T) =>
        updates
          .filter((item) => item.sessionId === sessionId && item.update.sessionUpdate === kind)
          .map((item) => item.update as Extract<SessionNotification["update"], { sessionUpdate: T }>),
      text: (sessionId: string, kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk") =>
        updates
          .filter((item) => item.sessionId === sessionId && item.update.sessionUpdate === kind)
          .map((item) => {
            const update = item.update as Extract<SessionNotification["update"], { sessionUpdate: typeof kind }>
            return update.content.type === "text" ? update.content.text : ""
          })
          .join(""),
    }
  })
}

export async function until(check: () => boolean, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

function pipe() {
  const state: { controller?: ReadableStreamDefaultController<Uint8Array>; closed: boolean } = { closed: false }
  const end = () => {
    if (state.closed) return
    state.closed = true
    state.controller?.close()
  }
  return {
    readable: new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.controller = controller
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!state.closed) state.controller?.enqueue(chunk)
      },
      close: end,
    }),
    end,
  }
}
