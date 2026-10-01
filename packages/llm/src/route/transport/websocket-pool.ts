import { Cause, Context, Effect, Layer, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError, TransportReason } from "../../schema"
import { fromWebSocket, messageText, type WebSocketConnection } from "./websocket"

/**
 * Session-scoped WebSocket connections reused across provider turns.
 *
 * A fresh HTTPS request per provider turn paid connection setup and request
 * routing every time; on the ChatGPT Codex backend a socket kept open for the
 * session measured 0.7-0.8s faster per call. One socket serves one response
 * at a time and stays open for the session's next turn. Anything that keeps a
 * socket from serving a request cleanly — busy, failing to open, or erroring
 * before the first frame — sends that request over HTTP instead, so the pool
 * only ever costs latency, never a turn.
 */
export interface PooledRequest {
  /** Session-scoped key; requests without one never use the pool. */
  readonly key: string
  readonly url: string
  readonly headers: Headers.Headers
  readonly message: string
}

export interface Interface {
  readonly stream: (
    request: PooledRequest,
    fallback: Stream.Stream<string, LLMError>,
  ) => Stream.Stream<string, LLMError>
  readonly close: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/LLM/WebSocketPool") {}

const IDLE_MS = 5 * 60_000
// The server closes a socket after 60 minutes; rotate before that, between turns.
const MAX_AGE_MS = 55 * 60_000
const CONNECT_TIMEOUT_MS = 15_000
const FAILURE_LIMIT = 3
const FALLBACK_MS = 10 * 60_000
const POOL_LIMIT = 32
const TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

interface Entry {
  readonly identity: string
  connection?: WebSocketConnection
  openedAt: number
  lastUsedAt: number
  busy: boolean
  failures: number
  fallbackUntil: number
}

export const make = (input: { readonly now?: () => number; readonly open?: typeof openSocket } = {}): Interface => {
  const now = input.now ?? Date.now
  const open = input.open ?? openSocket
  const entries = new Map<string, Entry>()

  const drop = (entry: Entry) =>
    Effect.suspend(() => {
      const connection = entry.connection
      entry.connection = undefined
      return connection ? connection.close : Effect.void
    })

  const prune = Effect.suspend(() => {
    const stale = [...entries.entries()].filter(
      ([, entry]) => !entry.busy && now() - entry.lastUsedAt > IDLE_MS && entry.fallbackUntil < now(),
    )
    stale.forEach(([key]) => entries.delete(key))
    return Effect.forEach(stale, ([, entry]) => drop(entry), { discard: true })
  })

  // Least recently used idle sessions give their socket up when the pool is full.
  const evict = Effect.suspend(() => {
    const idle = [...entries.entries()]
      .filter(([, entry]) => !entry.busy && entry.connection)
      .toSorted((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    const open = [...entries.values()].filter((entry) => entry.connection).length
    const surplus = idle.slice(0, Math.max(0, open - POOL_LIMIT + 1))
    return Effect.forEach(surplus, ([, entry]) => drop(entry), { discard: true })
  })

  const claim = (request: PooledRequest) =>
    Effect.gen(function* () {
      const identity = identityOf(request)
      const existing = entries.get(request.key)
      // Credentials or endpoint changed (token refresh, account switch): start over.
      if (existing && existing.identity !== identity && !existing.busy) {
        entries.delete(request.key)
        yield* drop(existing)
      }
      const entry = entries.get(request.key) ?? {
        identity,
        openedAt: 0,
        lastUsedAt: now(),
        busy: false,
        failures: 0,
        fallbackUntil: 0,
      }
      entries.set(request.key, entry)
      if (entry.busy || entry.identity !== identity || entry.fallbackUntil > now()) return undefined
      entry.busy = true
      return entry
    })

  const fail = (entry: Entry) =>
    Effect.suspend(() => {
      entry.failures++
      if (entry.failures >= FAILURE_LIMIT) {
        entry.fallbackUntil = now() + FALLBACK_MS
        entry.failures = 0
      }
      return drop(entry)
    })

  const connection = (entry: Entry, request: PooledRequest) =>
    Effect.gen(function* () {
      if (entry.connection && now() - entry.openedAt < MAX_AGE_MS) return entry.connection
      yield* drop(entry)
      yield* evict
      const startedAt = now()
      const opened = yield* open(request).pipe(
        Effect.timeoutOrElse({
          duration: CONNECT_TIMEOUT_MS,
          orElse: () => Effect.fail(poolError("open", "WebSocket connect timed out", request.url)),
        }),
      )
      entry.connection = opened
      entry.openedAt = now()
      yield* Effect.logInfo("llm.websocket", { event: "open", key: request.key, ms: entry.openedAt - startedAt })
      return opened
    })

  const stream: Interface["stream"] = (request, fallback) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* prune
        const entry = yield* claim(request)
        if (!entry) return fallback.pipe(Stream.onStart(fellBack(request, "unavailable")))
        const release = Effect.sync(() => {
          entry.busy = false
          entry.lastUsedAt = now()
        })
        const ready = yield* connection(entry, request).pipe(
          Effect.tap((socket) => socket.sendText(request.message)),
          Effect.result,
        )
        if (ready._tag === "Failure") {
          yield* fellBack(request, ready.failure.message)
          yield* fail(entry)
          yield* release
          return fallback
        }
        const decoder = new TextDecoder()
        let received = false
        let finished = false
        return ready.success.messages.pipe(
          Stream.map((message) => messageText(message, decoder)),
          Stream.tap((text) =>
            Effect.sync(() => {
              received = true
              if (TERMINAL.has(eventType(text))) finished = true
            }),
          ),
          Stream.takeUntil((text) => TERMINAL.has(eventType(text))),
          Stream.catchCause((cause) => {
            // A socket that broke before answering (closed while idle, dropped by
            // the server) costs nothing yet: retry this request over HTTP.
            if (!received)
              return Stream.unwrap(
                fellBack(request, Cause.pretty(cause)).pipe(Effect.andThen(fail(entry)), Effect.as(fallback)),
              )
            return Stream.unwrap(drop(entry).pipe(Effect.as(Stream.failCause(cause))))
          }),
          Stream.ensuring(
            Effect.suspend(() => {
              if (finished) entry.failures = 0
              // An unfinished response leaves frames in flight on this socket.
              return (finished ? Effect.void : drop(entry)).pipe(Effect.andThen(release))
            }),
          ),
        )
      }),
    )

  const close = Effect.suspend(() => {
    const all = [...entries.values()]
    entries.clear()
    return Effect.forEach(all, drop, { discard: true })
  })

  return { stream, close }
}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.acquireRelease(
    Effect.sync(() => make()),
    (pool) => pool.close,
  ),
)

const openSocket = (request: PooledRequest) =>
  Effect.try({
    try: () => {
      const proxy = proxyFor(request.url)
      return new (globalThis.WebSocket as unknown as WebSocketWithOptions)(request.url, {
        headers: request.headers,
        ...(proxy ? { proxy } : {}),
      })
    },
    catch: (error) =>
      poolError("open", error instanceof Error ? error.message : "Failed to construct WebSocket", request.url),
  }).pipe(Effect.flatMap((ws) => fromWebSocket(ws, { url: request.url, headers: request.headers })))

type WebSocketWithOptions = new (
  url: string,
  options?: { readonly headers?: Headers.Headers; readonly proxy?: string },
) => globalThis.WebSocket

// Bun applies HTTP(S)_PROXY to fetch but not to WebSockets, so pass it explicitly.
function proxyFor(url: string) {
  const host = new URL(url).hostname
  const bypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(",")
    .map((item) => item.trim().replace(/^\*?\./, ""))
    .filter(Boolean)
  if (bypass.some((item) => item === "*" || host === item || host.endsWith(`.${item}`))) return undefined
  return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
}

function identityOf(request: PooledRequest) {
  const auth = request.headers["authorization"] ?? ""
  const account = request.headers["chatgpt-account-id"] ?? ""
  return `${request.url}\u0000${auth}\u0000${account}`
}

function eventType(text: string) {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(text)
  return match?.[1] ?? ""
}

function fellBack(request: PooledRequest, reason: string) {
  return Effect.logInfo("llm.websocket", { event: "http-fallback", key: request.key, reason })
}

function poolError(method: string, message: string, url: string) {
  return new LLMError({ module: "WebSocketPool", method, reason: new TransportReason({ message, url, kind: method }) })
}

export * as WebSocketPool from "./websocket-pool"
