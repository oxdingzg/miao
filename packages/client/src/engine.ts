// A window may attach to an engine whose lifetime it does not own: the engine
// runs a loopback control plane (`engine-http-0`) with `POST /rpc` for requests
// and `GET /events` for a per-Session committed-event stream. This module is the
// renderer-side attachment: no process spawning, no bundled dependencies, and no
// assumption that it may terminate the engine when it closes.

const protocol = "engine-http-0"
const frameLimit = 16 * 1024 * 1024

export interface EngineEvent {
  session_id: string
  seq: number
  kind: string
  data: unknown
  /** Source commit time. Older engine stores can leave it unknown. */
  recorded_at_ms?: number | null
}

export interface EngineProgress {
  session_id?: string
  kind?: string
  [key: string]: unknown
}

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

export type EngineAdmitInput = {
  session_id: string
  input_id: string
  prompt: string
  delivery?: "steer" | "queue"
  [key: string]: unknown
}

export class EngineHttpClient {
  private next = 1
  private closed = false
  private failure?: EngineError
  private readonly events: Array<(event: EngineEvent) => void> = []
  private readonly progress: Array<(event: EngineProgress) => void> = []
  private readonly subscriptions = new Map<string, AbortController>()
  private readonly stop = new AbortController()
  private readonly url: URL

  constructor(private readonly options: { url: string; token: string; timeoutMs?: number }) {
    this.url = new URL(options.url)
    if (
      this.url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(this.url.hostname) ||
      !this.url.port ||
      this.url.username ||
      this.url.password ||
      this.url.pathname !== "/" ||
      this.url.search ||
      this.url.hash ||
      !options.token
    )
      throw new EngineError(
        "engine_http_authority",
        "an engine HTTP attachment requires a loopback origin and a bearer token",
      )
  }

  get stderrText() {
    return ""
  }

  onEvent(handler: (event: EngineEvent) => void) {
    this.events.push(handler)
  }

  onProgress(handler: (event: EngineProgress) => void) {
    this.progress.push(handler)
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) throw this.failure
    if (this.closed) throw new EngineError("engine_closed", "the engine attachment is closed")
    const id = this.next++
    const response = await fetch(new URL("/rpc", this.url), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.options.timeoutMs ?? 60_000)]),
    })
    this.validate(response)
    const message: unknown = await response.json()
    if (!record(message)) throw new EngineError("engine_protocol", "the engine response is not an envelope")
    if (record(message.error))
      throw new EngineError(
        typeof message.error.code === "string" ? message.error.code : "engine_http",
        typeof message.error.message === "string" ? message.error.message : "the engine request failed",
      )
    if (message.id !== id || !("result" in message))
      throw new EngineError("engine_protocol", "the engine response does not match its request")
    return message.result
  }

  async subscribe(session: string, after = 0): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closed) throw new EngineError("engine_closed", "the engine attachment is closed")
    if (this.subscriptions.has(session)) return
    const controller = new AbortController()
    this.subscriptions.set(session, controller)
    const url = new URL("/events", this.url)
    url.searchParams.set("session_id", session)
    url.searchParams.set("after", String(after))
    try {
      const response = await fetch(url, { headers: this.headers(), signal: controller.signal })
      this.validate(response)
      if (!response.body) throw new EngineError("engine_protocol", "the engine event response has no body")
      void this.readEvents(response.body, session, after, controller).catch((error: unknown) => {
        if (controller.signal.aborted) return
        this.failure =
          error instanceof EngineError
            ? error
            : new EngineError("engine_stream", "the engine event stream failed; reconnect the attachment")
        this.abortSubscriptions()
      })
    } catch (error) {
      this.subscriptions.delete(session)
      controller.abort()
      throw error
    }
  }

  admit(input: EngineAdmitInput, resume = true, attachments: unknown[] = []) {
    return this.request("admit", { input, resume, ...(attachments.length ? { attachments } : {}) })
  }

  /** Closing one window must not terminate the engine or its other attachments. */
  async close() {
    if (this.closed) return
    this.closed = true
    this.stop.abort()
    this.abortSubscriptions()
  }

  private headers() {
    return {
      authorization: `Bearer ${this.options.token}`,
      "miao-engine-protocol": protocol,
      "content-type": "application/json",
    }
  }

  private abortSubscriptions() {
    for (const controller of this.subscriptions.values()) controller.abort()
    this.subscriptions.clear()
  }

  private validate(response: Response) {
    if (!response.ok) throw new EngineError("engine_http", `the engine request failed (${response.status})`)
    if (response.headers.get("miao-engine-protocol") !== protocol)
      throw new EngineError("engine_protocol", "the engine protocol revision does not match")
  }

  private async readEvents(
    body: ReadableStream<Uint8Array>,
    session: string,
    after: number,
    controller: AbortController,
  ) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const state = { buffer: "", kind: "", data: [] as string[], bytes: 0, cursor: after }
    const dispatch = () => {
      if (!state.data.length) return
      const value: unknown = JSON.parse(state.data.join("\n"))
      if (state.kind === "event") {
        if (
          !record(value) ||
          value.session_id !== session ||
          typeof value.seq !== "number" ||
          !Number.isSafeInteger(value.seq) ||
          value.seq < 1 ||
          typeof value.kind !== "string" ||
          !("data" in value)
        )
          throw new EngineError("engine_protocol", "invalid committed engine event")
        // Replay and live delivery overlap by design: the stream is authoritative
        // on ordering, so a repeated cursor is dropped rather than re-rendered.
        if (value.seq <= state.cursor) return
        state.cursor = value.seq
        const event: EngineEvent = {
          session_id: session,
          seq: value.seq,
          kind: value.kind,
          data: value.data,
          ...(typeof value.recorded_at_ms === "number" ? { recorded_at_ms: value.recorded_at_ms } : {}),
        }
        for (const handler of this.events) handler(event)
      }
      if (state.kind === "progress" || state.kind === "resync") {
        if (!record(value)) throw new EngineError("engine_protocol", "invalid engine progress event")
        for (const handler of this.progress) handler({ ...value, session_id: session })
      }
    }
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        state.buffer += decoder.decode(chunk.value, { stream: true })
        if (state.buffer.length > frameLimit)
          throw new EngineError("engine_protocol", "an engine event line exceeds the limit")
        for (;;) {
          const index = state.buffer.indexOf("\n")
          if (index < 0) break
          const line = state.buffer.slice(0, index).replace(/\r$/, "")
          state.buffer = state.buffer.slice(index + 1)
          if (!line) {
            dispatch()
            state.kind = ""
            state.data = []
            state.bytes = 0
            continue
          }
          if (line.startsWith("event:")) state.kind = line.slice(6).trimStart()
          if (line.startsWith("data:")) {
            state.bytes += line.length
            if (state.bytes > frameLimit) throw new EngineError("engine_protocol", "an engine event frame exceeds the limit")
            state.data.push(line.slice(5).replace(/^ /, ""))
          }
        }
      }
      if (!controller.signal.aborted) throw new EngineError("engine_stream", "the engine event stream ended")
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      if (this.subscriptions.get(session) === controller) this.subscriptions.delete(session)
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
