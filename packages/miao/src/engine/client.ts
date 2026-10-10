import { spawn } from "bun"
import { EOL } from "os"

/**
 * Host-side client for the experimental Rust engine (`miao-engine serve`).
 *
 * The engine speaks newline-delimited JSON over stdio: requests carry an `id` and
 * a `method`/`params` pair, replies echo the `id` with either `result` or `error`,
 * and committed events plus ephemeral progress arrive as `method: "event"` and
 * `method: "progress"` messages. This client owns the child process and never
 * touches the miao database, so an engine session stays isolated from the
 * TypeScript runtime.
 */

export interface EngineOptions {
  binary: string
  db: string
  workspace: string
  model: string
  provider?: string
  endpoint?: string
  authFile?: string
  policyFile?: string
  toolReplayFile?: string
  env?: Record<string, string | undefined>
}

export interface EngineEvent {
  session_id: string
  seq: number
  kind: string
  data: unknown
  /** Source commit time. Older engine stores and sidecars can leave it unknown. */
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

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class EngineClient {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers: Array<(event: EngineEvent) => void> = []
  private readonly progressHandlers: Array<(progress: EngineProgress) => void> = []
  private readonly lines = { buffer: "" }
  private stderr = ""
  private closed = false

  private constructor(private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.readStdout()
    void this.readStderr()
    void this.child.exited.then(() => this.fail(new EngineError("engine_closed", "miao-engine exited")))
  }

  static start(options: EngineOptions): EngineClient {
    const args = ["serve", "--db", options.db, "--workspace", options.workspace, "--model", options.model]
    if (options.provider) args.push("--provider", options.provider)
    if (options.endpoint) args.push("--endpoint", options.endpoint)
    if (options.authFile) args.push("--auth-file", options.authFile)
    if (options.policyFile) args.push("--policy", options.policyFile)
    if (options.toolReplayFile) args.push("--tool-replay", options.toolReplayFile)
    return new EngineClient(
      spawn([options.binary, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...options.env },
      }),
    )
  }

  onEvent(handler: (event: EngineEvent) => void) {
    this.eventHandlers.push(handler)
  }

  onProgress(handler: (progress: EngineProgress) => void) {
    this.progressHandlers.push(handler)
  }

  get stderrText() {
    return this.stderr
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++
    this.child.stdin.write(JSON.stringify({ id, method, params }) + EOL)
    void this.child.stdin.flush()
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  admit(input: { session_id: string; input_id: string; prompt: string; delivery?: "steer" | "queue" }, resume = true) {
    return this.request("admit", { input, resume })
  }

  subscribe(session: string, after = 0) {
    return this.request("subscribe", { session_id: session, after })
  }

  cancel(session: string) {
    return this.request("cancel", { session_id: session })
  }

  approve(session: string, response: unknown) {
    return this.request("approve", { session_id: session, response })
  }

  answerQuestion(session: string, answer: unknown) {
    return this.request("answer_question", { session_id: session, answer })
  }

  history(session: string, selected = true) {
    return this.request("history", { session_id: session, selected })
  }

  shutdown() {
    return this.request("shutdown", {})
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    await this.child.exited
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private dispatch(line: string) {
    const message = JSON.parse(line) as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { code?: string; message?: string }
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new EngineError(message.error.code ?? "engine_error", message.error.message ?? "miao-engine error"),
        )
        return
      }
      pending.resolve(message.result)
      return
    }
    if (message.method === "event") for (const handler of this.eventHandlers) handler(message.params as EngineEvent)
    if (message.method === "progress")
      for (const handler of this.progressHandlers) handler(message.params as EngineProgress)
  }

  private async readStdout() {
    const decoder = new TextDecoder()
    const reader = this.child.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.lines.buffer += decoder.decode(value, { stream: true })
      let index = this.lines.buffer.indexOf("\n")
      while (index >= 0) {
        const line = this.lines.buffer.slice(0, index)
        this.lines.buffer = this.lines.buffer.slice(index + 1)
        if (line.trim()) this.dispatch(line)
        index = this.lines.buffer.indexOf("\n")
      }
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder()
    const reader = this.child.stderr.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.stderr = (this.stderr + decoder.decode(value)).slice(-8192)
    }
  }
}
