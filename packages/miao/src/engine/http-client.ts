import { EngineError, type EngineEvent, type EngineProgress, type EngineTransport } from "./client"

const protocol = "engine-http-0"
const frameLimit = 16 * 1024 * 1024

/** A window-local attachment to an engine whose lifetime is owned elsewhere. */
export class EngineHttpClient implements EngineTransport {
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
        "native HTTP transport requires a loopback origin and bearer token",
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

  private headers() {
    return {
      authorization: `Bearer ${this.options.token}`,
      "miao-engine-protocol": protocol,
      "content-type": "application/json",
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) throw this.failure
    if (this.closed) throw new EngineError("engine_closed", "native HTTP attachment is closed")
    const id = this.next++
    const response = await fetch(new URL("/rpc", this.url), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.options.timeoutMs ?? 60_000)]),
    })
    this.validate(response)
    const message: unknown = await response.json()
    if (!record(message)) throw new EngineError("engine_protocol", "native HTTP response is not an envelope")
    if (record(message.error))
      throw new EngineError(
        typeof message.error.code === "string" ? message.error.code : "engine_http",
        typeof message.error.message === "string" ? message.error.message : "native HTTP request failed",
      )
    if (message.id !== id || !("result" in message))
      throw new EngineError("engine_protocol", "native HTTP response does not match its request")
    return message.result
  }

  async subscribe(session: string, after = 0): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closed) throw new EngineError("engine_closed", "native HTTP attachment is closed")
    if (this.subscriptions.has(session)) return
    const controller = new AbortController()
    this.subscriptions.set(session, controller)
    const url = new URL("/events", this.url)
    url.searchParams.set("session_id", session)
    url.searchParams.set("after", String(after))
    try {
      const response = await fetch(url, { headers: this.headers(), signal: controller.signal })
      this.validate(response)
      if (!response.body) throw new EngineError("engine_protocol", "native event response has no body")
      void this.readEvents(response.body, session, after, controller).catch((error: unknown) => {
        if (controller.signal.aborted) return
        this.failure =
          error instanceof EngineError
            ? error
            : new EngineError("engine_stream", "native HTTP event stream failed; reconnect the attachment")
        this.abortSubscriptions()
      })
    } catch (error) {
      this.subscriptions.delete(session)
      controller.abort()
      throw error
    }
  }

  admit(input: Parameters<EngineTransport["admit"]>[0], resume = true) {
    return this.request("admit", { input, resume })
  }

  /** Closing one window must not terminate the engine or its other attachments. */
  async close() {
    if (this.closed) return
    this.closed = true
    this.stop.abort()
    this.abortSubscriptions()
  }

  private abortSubscriptions() {
    for (const controller of this.subscriptions.values()) controller.abort()
    this.subscriptions.clear()
  }

  private validate(response: Response) {
    if (!response.ok) throw new EngineError("engine_http", `native HTTP request failed (${response.status})`)
    if (response.headers.get("miao-engine-protocol") !== protocol)
      throw new EngineError("engine_protocol", "native HTTP protocol revision mismatch")
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
          !Number.isSafeInteger(value.seq) ||
          typeof value.seq !== "number" ||
          value.seq < 1 ||
          typeof value.kind !== "string" ||
          !("data" in value)
        )
          throw new EngineError("engine_protocol", "invalid native committed event")
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
        if (!record(value)) throw new EngineError("engine_protocol", "invalid native progress event")
        for (const handler of this.progress) handler({ ...value, session_id: session })
      }
    }
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        state.buffer += decoder.decode(chunk.value, { stream: true })
        if (state.buffer.length > frameLimit)
          throw new EngineError("engine_protocol", "native event line exceeds limit")
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
            if (state.bytes > frameLimit) throw new EngineError("engine_protocol", "native event frame exceeds limit")
            state.data.push(line.slice(5).replace(/^ /, ""))
          }
        }
      }
      if (!controller.signal.aborted) throw new EngineError("engine_stream", "native HTTP event stream ended")
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
