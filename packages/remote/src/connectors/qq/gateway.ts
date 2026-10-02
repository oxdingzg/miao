// QQ bot WebSocket gateway over Bun's native WebSocket. Protocol from the
// official Node SDK (gateway/gateway-connection.ts, gateway/reconnect.ts):
// Hello(10) → Identify(2) or Resume(6) → Dispatch(0) READY/RESUMED; Heartbeat(1)
// every heartbeat_interval with the last seq, answered by HeartbeatAck(11);
// Reconnect(7) and InvalidSession(9) from the server. The session id and last
// seq are persisted so a restart resumes instead of losing queued events.

export const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

export const CloseCode = {
  AuthFailed: 4004,
  InvalidSession: 4006,
  SeqOutOfRange: 4007,
  RateLimited: 4008,
  SessionTimeout: 4009,
  /** The bot was taken offline. */
  Offline: 4914,
  /** The bot was banned. */
  Banned: 4915,
} as const

/** C2C and group messages; the only intent a private-chat remote control needs. */
export const Intents = 1 << 25

export type GatewaySession = { readonly sessionID: string; readonly seq: number }

export type GatewayOptions = {
  readonly token: () => Promise<string>
  /** Forgets the cached token so the next connect fetches a new one. */
  readonly invalidateToken: () => void
  readonly url: () => Promise<string>
  readonly load: () => Promise<GatewaySession | undefined>
  readonly save: (session: GatewaySession | undefined) => void
  readonly onDispatch: (type: string, data: unknown) => void | Promise<void>
  readonly onState: (state: "connecting" | "connected" | "retrying", error?: string) => void
  /** The bot cannot connect again without a new login (4914 offline, 4915 banned). */
  readonly onFatal: (reason: string) => void
  readonly log: (message: string) => void
  /** First reconnect delay; doubles up to 60 seconds. */
  readonly reconnectMs?: number
  readonly rateLimitMs?: number
}

const MaxDelayMs = 60_000

export function createGateway(options: GatewayOptions) {
  const state = {
    stopped: false,
    socket: undefined as WebSocket | undefined,
    heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
    retry: undefined as ReturnType<typeof setTimeout> | undefined,
    acked: true,
    attempts: 0,
    session: undefined as { sessionID?: string; seq?: number } | undefined,
  }

  return { start, stop, reconnect: () => state.socket?.close(4000, "client reconnect") }

  async function start() {
    const stored = await options.load()
    state.session = stored ? { sessionID: stored.sessionID, seq: stored.seq } : undefined
    void connect()
  }

  async function stop() {
    state.stopped = true
    clearTimeout(state.retry)
    clearInterval(state.heartbeat)
    const socket = state.socket
    state.socket = undefined
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
    socket.close(1000, "stop")
    await Promise.race([closed, Bun.sleep(2000)])
  }

  async function connect() {
    if (state.stopped) return
    options.onState("connecting")
    const opened = await Promise.all([options.token(), options.url()]).catch((error: unknown) => error)
    if (state.stopped) return
    if (!Array.isArray(opened)) {
      const message = opened instanceof Error ? opened.message : String(opened)
      options.log(`qq: gateway connect failed: ${message}`)
      options.onState("retrying", message)
      return schedule()
    }
    const [token, url] = opened
    const socket = new WebSocket(url)
    state.socket = socket
    state.acked = true
    socket.addEventListener("message", (event) => {
      if (state.socket !== socket) return
      void handle(socket, token, String(event.data))
    })
    socket.addEventListener("close", (event) => {
      if (state.socket !== socket) return
      state.socket = undefined
      clearInterval(state.heartbeat)
      closed(event.code, event.reason)
    })
    socket.addEventListener("error", () => options.log("qq: gateway socket error"))
  }

  async function handle(socket: WebSocket, token: string, raw: string) {
    const payload = parse(raw)
    if (!payload) return
    if (typeof payload.s === "number") {
      state.session = { ...state.session, seq: payload.s }
      persist()
    }
    if (payload.op === Op.Hello) {
      const session = state.session
      const resume = session?.sessionID && session.seq !== undefined
      socket.send(
        JSON.stringify(
          resume
            ? { op: Op.Resume, d: { token: `QQBot ${token}`, session_id: session.sessionID, seq: session.seq } }
            : { op: Op.Identify, d: { token: `QQBot ${token}`, intents: Intents, shard: [0, 1] } },
        ),
      )
      const interval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval) || 41_250
      clearInterval(state.heartbeat)
      state.heartbeat = setInterval(() => beat(socket), interval)
      return
    }
    if (payload.op === Op.HeartbeatAck) {
      state.acked = true
      return
    }
    if (payload.op === Op.Reconnect) {
      socket.close(4000, "server asked to reconnect")
      return
    }
    if (payload.op === Op.InvalidSession) {
      // d=false: the session cannot be resumed; identify from scratch.
      if (payload.d !== true) forget()
      socket.close(4000, "invalid session")
      return
    }
    if (payload.op !== Op.Dispatch || typeof payload.t !== "string") return
    if (payload.t === "READY") {
      const sessionID = (payload.d as { session_id?: string } | undefined)?.session_id
      if (sessionID) state.session = { sessionID, seq: state.session?.seq ?? payload.s ?? 0 }
      persist()
      return ready()
    }
    if (payload.t === "RESUMED") return ready()
    await Promise.resolve(options.onDispatch(payload.t, payload.d)).catch((error: unknown) =>
      options.log(`qq: handling ${payload.t} failed: ${String(error)}`),
    )
  }

  function ready() {
    state.attempts = 0
    options.onState("connected")
  }

  // A missing ack means a half-open connection; drop it and resume on a fresh one.
  function beat(socket: WebSocket) {
    if (!state.acked) {
      options.log("qq: heartbeat not acknowledged; reconnecting")
      socket.close(4000, "heartbeat timeout")
      return
    }
    state.acked = false
    socket.send(JSON.stringify({ op: Op.Heartbeat, d: state.session?.seq ?? null }))
  }

  function closed(code: number, reason: string) {
    if (state.stopped) return
    if (code === CloseCode.Offline || code === CloseCode.Banned) {
      const why = code === CloseCode.Offline ? "QQ 机器人已下架或只限沙箱（4914）" : "QQ 机器人已被封禁（4915）"
      options.log(`qq: gateway closed with ${code}; stopping until a new login`)
      forget()
      options.onFatal(why)
      return
    }
    options.log(`qq: gateway closed: ${code} ${reason}`.trim())
    options.onState("retrying", `gateway closed ${code}`)
    if (code === CloseCode.AuthFailed) options.invalidateToken()
    if (code === CloseCode.InvalidSession || code === CloseCode.SeqOutOfRange || (code >= 4900 && code <= 4913)) {
      forget()
      options.invalidateToken()
    }
    if (code === CloseCode.RateLimited) return schedule(options.rateLimitMs ?? 60_000)
    // 4009 (session timed out) keeps the session: the next Hello resumes it.
    schedule()
  }

  function schedule(delay?: number) {
    if (state.stopped) return
    const base = options.reconnectMs ?? 1000
    const wait = delay ?? Math.min(MaxDelayMs, base * 2 ** state.attempts)
    state.attempts += 1
    clearTimeout(state.retry)
    state.retry = setTimeout(() => void connect(), wait)
  }

  function forget() {
    state.session = undefined
    options.save(undefined)
  }

  function persist() {
    const session = state.session
    if (session?.sessionID && session.seq !== undefined)
      options.save({ sessionID: session.sessionID, seq: session.seq })
  }
}

type Payload = { readonly op?: number; readonly d?: unknown; readonly s?: number; readonly t?: string }

function parse(raw: string): Payload | undefined {
  const value: unknown = (() => {
    // Gateway frames are JSON from the server; a malformed one is skipped rather than fatal.
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  return typeof value === "object" && value !== null ? (value as Payload) : undefined
}
