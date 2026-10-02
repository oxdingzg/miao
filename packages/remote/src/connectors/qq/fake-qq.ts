// A local stand-in for the QQ open platform, for tests: the bind portal, the
// token endpoint, the OpenAPI message route, and the WebSocket gateway, all on
// one 127.0.0.1 port. It records every request and gateway frame and lets a test
// script bind results, send failures, dispatches, and close codes.
import type { ServerWebSocket } from "bun"
import { encryptSecret } from "./bind"
import { Op } from "./gateway"

export type FakeRequest = {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

export type Frame = { readonly op: number; readonly d?: unknown; readonly s?: number; readonly t?: string }

type SocketData = { readonly id: number }

export function createFakeQQ(input: { appId?: string; secret?: string; heartbeatMs?: number } = {}) {
  const appId = input.appId ?? "102000001"
  const secret = input.secret ?? "app-secret"
  const requests: FakeRequest[] = []
  const rejected = new WeakSet<FakeRequest>()
  const frames: Array<Frame & { readonly socket: number }> = []
  const sends: Array<{ readonly status: number; readonly err_code: number; readonly message: string }> = []
  const tasks = new Map<string, { key: string; results: Array<Record<string, unknown>> }>()
  const sessions = new Set<string>()
  const queued: Array<{ t: string; d: unknown }> = []
  const waiters = new Set<() => void>()
  const counter = { token: 0, task: 0, session: 0, seq: 0, message: 0, socket: 0, expiresIn: "7200" as string | number }
  const live = { socket: undefined as ServerWebSocket<SocketData> | undefined, ready: false }
  const notify = () => waiters.forEach((wake) => wake())

  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname === "/ws") {
        counter.socket += 1
        if (server.upgrade(request, { data: { id: counter.socket } })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      const body =
        request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}
      const record = {
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body,
      }
      requests.push(record)
      notify()
      if (url.pathname === "/lite/create_bind_task") {
        counter.task += 1
        const task = `task-${counter.task}`
        tasks.set(task, { key: String(body.key ?? ""), results: [] })
        return Response.json({ retcode: 0, msg: "ok", data: { task_id: task } })
      }
      if (url.pathname === "/lite/poll_bind_result") {
        const task = tasks.get(String(body.task_id ?? ""))
        if (!task) return Response.json({ retcode: 1, msg: "no such task" })
        return Response.json({ retcode: 0, data: task.results.shift() ?? { status: 1 } })
      }
      if (url.pathname === "/app/getAppAccessToken") {
        if (body.appId !== appId || body.clientSecret !== secret)
          return Response.json({ code: 100016, message: "invalid appid or secret" }, { status: 401 })
        counter.token += 1
        return Response.json({ access_token: `token-${counter.token}`, expires_in: counter.expiresIn })
      }
      if (!validToken(request.headers.get("authorization")))
        return Response.json({ code: 11244, message: "token not exist or expire" }, { status: 401 })
      if (url.pathname === "/gateway") return Response.json({ url: `ws://127.0.0.1:${server.port}/ws` })
      if (url.pathname.startsWith("/v2/users/") && url.pathname.endsWith("/messages")) {
        const failure = sends.shift()
        if (failure) rejected.add(record)
        if (failure)
          return Response.json(
            { err_code: failure.err_code, message: failure.message, trace_id: "trace" },
            { status: failure.status },
          )
        counter.message += 1
        return Response.json({ id: `ROBOT1.0_${counter.message}`, timestamp: new Date().toISOString() })
      }
      return Response.json({ code: 404, message: "not found" }, { status: 404 })
    },
    websocket: {
      open: (socket) => {
        live.socket = socket
        live.ready = false
        socket.send(JSON.stringify({ op: Op.Hello, d: { heartbeat_interval: input.heartbeatMs ?? 30_000 } }))
      },
      message: (socket, message) => {
        const frame = JSON.parse(String(message)) as Frame
        frames.push({ ...frame, socket: socket.data.id })
        notify()
        if (frame.op === Op.Heartbeat && !fake.silent) {
          socket.send(JSON.stringify({ op: Op.HeartbeatAck }))
          return
        }
        const token = String((frame.d as { token?: string } | undefined)?.token ?? "")
        if (frame.op === Op.Identify) {
          if (!validToken(token)) {
            socket.close(4004, "invalid token")
            return
          }
          counter.session += 1
          const session = `session-${counter.session}`
          sessions.add(session)
          send(socket, "READY", { session_id: session, version: 1, user: { id: appId, bot: true } })
          ready(socket)
          return
        }
        if (frame.op !== Op.Resume) return
        const session = String((frame.d as { session_id?: string } | undefined)?.session_id ?? "")
        if (!validToken(token) || !sessions.has(session)) {
          socket.send(JSON.stringify({ op: Op.InvalidSession, d: false }))
          return
        }
        send(socket, "RESUMED", "")
        ready(socket)
      },
      close: (socket) => {
        if (live.socket === socket) {
          live.socket = undefined
          live.ready = false
          notify()
        }
      },
    },
  })

  function validToken(header: string | null) {
    const match = /^QQBot token-(\d+)$/.exec(header ?? "")
    return match !== null && Number(match[1]) <= counter.token
  }

  function send(socket: ServerWebSocket<SocketData>, t: string, d: unknown) {
    counter.seq += 1
    socket.send(JSON.stringify({ op: Op.Dispatch, s: counter.seq, t, d }))
  }

  function ready(socket: ServerWebSocket<SocketData>) {
    live.ready = true
    notify()
    queued.splice(0).forEach((event) => send(socket, event.t, event.d))
  }

  const fake = {
    url: `http://127.0.0.1:${server.port}`,
    /** When true, heartbeats go unanswered (a half-open connection). */
    silent: false,
    appId,
    secret,
    requests,
    frames,
    /** Sessions the server will accept a Resume for. */
    sessions,
    /** Makes the bind task complete on its next poll, with the secret sealed under the task's key. */
    completeBind: async (owner: string | undefined, task = `task-${counter.task}`) => {
      const entry = tasks.get(task)
      if (!entry) throw new Error(`fake QQ: no bind task ${task}`)
      entry.results.push({
        status: 2,
        bot_appid: Number(appId),
        bot_encrypt_secret: await encryptSecret(secret, entry.key),
        ...(owner ? { user_openid: owner } : {}),
      })
    },
    expireBind: (task = `task-${counter.task}`) => tasks.get(task)?.results.push({ status: 3 }),
    tasks: () => [...tasks.keys()],
    /** Delivers a private message; held until the gateway is ready, like the platform's resume buffer. */
    c2c: (message: { from: string; text: string; id: string; attachments?: ReadonlyArray<unknown> }) =>
      fake.dispatch("C2C_MESSAGE_CREATE", {
        id: message.id,
        content: message.text,
        timestamp: new Date().toISOString(),
        author: { user_openid: message.from, id: message.from },
        ...(message.attachments ? { attachments: message.attachments } : {}),
      }),
    dispatch: (t: string, d: unknown) => {
      if (live.socket && live.ready) return send(live.socket, t, d)
      queued.push({ t, d })
    },
    /** Closes the gateway connection from the server side. */
    close: (code: number, reason = "") => live.socket?.close(code, reason),
    /** Asks the client to reconnect (op 7). */
    reconnect: () => live.socket?.send(JSON.stringify({ op: Op.Reconnect })),
    invalidSession: (resumable: boolean) => live.socket?.send(JSON.stringify({ op: Op.InvalidSession, d: resumable })),
    /** Fails the next message sends with these platform errors, in order. */
    failSend: (...failures: Array<{ err_code: number; message?: string; status?: number }>) =>
      sends.push(
        ...failures.map((item) => ({
          status: item.status ?? 400,
          err_code: item.err_code,
          message: item.message ?? "error",
        })),
      ),
    tokenLifetime: (seconds: number | string) => {
      counter.expiresIn = seconds
    },
    tokensIssued: () => counter.token,
    connected: () => live.ready,
    /** Message bodies sent to users in order, including ones the fake rejected. */
    messages: (): Array<Record<string, unknown> & { readonly to: string }> =>
      requests
        .filter((request) => request.path.startsWith("/v2/users/"))
        .map((request) => ({ to: decodeURIComponent(request.path.split("/")[3]), ...request.body })),
    /** Message bodies the fake accepted, in order. */
    delivered: (): Array<Record<string, unknown> & { readonly to: string }> =>
      requests
        .filter((request) => request.path.startsWith("/v2/users/") && !rejected.has(request))
        .map((request) => ({ to: decodeURIComponent(request.path.split("/")[3]), ...request.body })),
    until: <A>(check: () => A | undefined | false, timeoutMs = 10_000) =>
      new Promise<A>((resolve, reject) => {
        const test = () => {
          const value = check()
          if (value === undefined || value === false) return
          waiters.delete(test)
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => {
          waiters.delete(test)
          reject(new Error(`fake QQ: condition not met within ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.add(test)
        test()
      }),
    stop: () => server.stop(true),
  }
  return fake
}

export type FakeQQ = ReturnType<typeof createFakeQQ>
