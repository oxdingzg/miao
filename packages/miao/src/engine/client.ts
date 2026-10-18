import { spawn } from "bun"
import { EOL } from "os"
import type { ConfigMCP } from "@miao/schema/config/mcp"
import type { ResponsesCacheContract, ResponsesWebSocketContract } from "@miao/schema/config"
import { prepareMcpConfig } from "./mcp-config"

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
  /** ADR-12 worker host config passed as `--worker-config`; absent keeps extension tools off. */
  workerConfigFile?: string
  provider?: string
  endpoint?: string
  authFile?: string
  policyFile?: string
  toolReplayFile?: string
  /** Automatic compaction limits (roadmap §2.13); absent keeps it off. */
  contextLimits?: {
    window: number
    ratio: number
    headroom: number
    perPass: number
    /** Per-payload elision budget; absent leaves tool output whole. */
    pruneChars?: number
    /** Total elision budget; absent elides every candidate. */
    pruneTotalChars?: number
    /** Newest user-role messages whose tool output is never elided. */
    protectTurns?: number
  }
  /** Transport-failure fallback model on the same route. */
  fallbackModel?: string
  responsesCacheContract?: ResponsesCacheContract
  responsesWebSocketContract?: ResponsesWebSocketContract
  toolDisclosure?: "full" | "compact"
  /** Purpose-role model bindings (ADR-14): model ids on the engine's own route. */
  roles?: { summarize?: string; retrieve?: string; verify?: string }
  /**
   * The product's own credential database (ADR-09: the product owns refresh and
   * writes; the engine only reads). Together with `credentialID` and
   * `credentialIntegration` this is the explicit credential channel; without it
   * the caller passes provider keys through `env`.
   */
  credentialDatabase?: string
  credentialID?: string
  credentialIntegration?: string
  /** Evaluation ablation control; `false` disables stale-edit recovery. */
  editRecovery?: boolean
  /** Evaluation ablation control; `false` disables LSP warm-up and post-edit diagnostics. */
  lspDiagnostics?: boolean
  /** Absolute path to an MCP host config; requires explicit allow_mcp policy authority. */
  mcpConfigFile?: string
  /** Trusted global MCP settings; materialized only with explicit native MCP policy authority. */
  mcpSettings?: ConfigMCP.Info
  /** Absolute path to an LSP host config; must live outside the workspace. */
  lspConfigFile?: string
  formatterConfigFile?: string
  /** Trusted instruction sources, skill directories, and exact read-only reference grants. */
  contextConfigFile?: string
  /** Whether standalone workspace AGENTS.md discovery is enabled (default true). */
  workspaceInstructions?: boolean
  skillsConfigFile?: string
  referencesConfigFile?: string
  /** Host-owned lifecycle hooks; commands run under the same sandbox as bash. */
  hooksConfigFile?: string
  /** Host-owned exact model routes; endpoint/credential bindings never come from a Session request. */
  modelRoutesConfigFile?: string
  /**
   * Explicit prefix-cache policy for the first model turn's stable prefix.
   * Absent leaves each provider's own caching behavior untouched.
   */
  promptCache?: boolean
  /**
   * Command line the engine runs before a run may finish, e.g. a type check or
   * a focused test command; a failure becomes a classified continuation.
   */
  verifyCommand?: string
  env?: Record<string, string | undefined>
}

/**
 * Everything that may cross into the engine child: the process basics it needs
 * to run, the provider credentials it authenticates with, and its own
 * deployment knobs. Unrelated secrets in the operator's environment (cloud
 * tokens, CI secrets, other providers' keys) never reach it, and the caller's
 * `env` still overrides any of these.
 */
const INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  // Provider credentials the engine reads.
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "OPENAI_ACCOUNT_ID",
  "GEMINI_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "MIAO_WEB_SEARCH_PROVIDER",
  "MIAO_WEB_SEARCH_ENDPOINT",
  // Engine deployment knobs.
  "MIAO_ENGINE_VERSION",
  "MIAO_ENGINE_HTTP_TOKEN",
  "MIAO_LLM_FIRST_BYTE_TIMEOUT_MS",
  "MIAO_TOOL_INPUT_MAX_BYTES",
  "MIAO_TOOL_INPUT_TIMEOUT_MS",
] as const

/**
 * The child engine's environment: the process basics above plus exactly what the
 * caller passed. Exported so the boundary is testable without spawning a process.
 */
export function engineEnvironment(
  explicit: Record<string, string | undefined> | undefined,
  inherited: Record<string, string | undefined> = process.env,
) {
  const environment: Record<string, string | undefined> = {}
  for (const key of INHERITED_ENVIRONMENT) {
    if (inherited[key] !== undefined) environment[key] = inherited[key]
  }
  return { ...environment, ...explicit }
}

/** The argv the child engine is spawned with; pure so tests can assert it. */
export function engineArgs(options: EngineOptions): string[] {
  const args = ["serve", "--db", options.db, "--workspace", options.workspace, "--model", options.model]
  if (options.workerConfigFile) console.log("[worker-host] engine argv includes --worker-config")
  if (options.workerConfigFile) args.push("--worker-config", options.workerConfigFile)
  if (options.provider) args.push("--provider", options.provider)
  if (options.endpoint) args.push("--endpoint", options.endpoint)
  if (options.authFile) args.push("--auth-file", options.authFile)
  if (options.policyFile) args.push("--policy", options.policyFile)
  if (options.toolReplayFile) args.push("--tool-replay", options.toolReplayFile)
  if (options.contextLimits) args.push("--context-limits", JSON.stringify(options.contextLimits))
  if (options.credentialDatabase) args.push("--credential-db", options.credentialDatabase)
  if (options.credentialID) args.push("--credential-id", options.credentialID)
  if (options.credentialIntegration) args.push("--credential-integration", options.credentialIntegration)
  if (options.editRecovery === false) args.push("--edit-recovery", "off")
  if (options.lspDiagnostics === false) args.push("--lsp-diagnostics", "off")
  if (options.mcpConfigFile) args.push("--mcp-config", options.mcpConfigFile)
  if (options.lspConfigFile) args.push("--lsp-config", options.lspConfigFile)
  if (options.formatterConfigFile) args.push("--formatter-config", options.formatterConfigFile)
  if (options.contextConfigFile) args.push("--context-config", options.contextConfigFile)
  if (options.workspaceInstructions !== undefined)
    args.push("--workspace-instructions", String(options.workspaceInstructions))
  if (options.skillsConfigFile) args.push("--skills-config", options.skillsConfigFile)
  if (options.referencesConfigFile) args.push("--references-config", options.referencesConfigFile)
  if (options.hooksConfigFile) args.push("--hooks-config", options.hooksConfigFile)
  if (options.modelRoutesConfigFile) args.push("--model-routes-config", options.modelRoutesConfigFile)
  if (options.promptCache !== undefined) args.push("--prompt-cache", options.promptCache ? "on" : "off")
  if (options.responsesCacheContract)
    args.push("--responses-cache-contract", JSON.stringify(options.responsesCacheContract))
  if (options.responsesWebSocketContract)
    args.push("--responses-websocket-contract", JSON.stringify(options.responsesWebSocketContract))
  if (options.verifyCommand) args.push("--verify-command", options.verifyCommand)
  if (options.fallbackModel) args.push("--fallback-model", options.fallbackModel)
  if (options.toolDisclosure) args.push("--tool-disclosure", options.toolDisclosure)
  if (options.roles?.summarize) args.push("--role-summarize", options.roles.summarize)
  if (options.roles?.retrieve) args.push("--role-retrieve", options.roles.retrieve)
  if (options.roles?.verify) args.push("--role-verify", options.roles.verify)
  return args
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

export type EngineTransport = Pick<
  EngineClient,
  "request" | "subscribe" | "admit" | "onEvent" | "onProgress" | "close" | "stderrText"
>

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
  private failure?: Error
  private readonly exited: Promise<void>
  private inputFailure?: Promise<void>

  private constructor(
    private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly cleanup = () => {},
  ) {
    const stdout = this.readStdout().catch(() => {
      this.fail(new EngineError("engine_protocol", "miao-engine output stream failed"), true)
      this.child.kill()
    })
    const stderr = this.readStderr().catch(() => {})
    this.exited = this.child.exited.then(async (code) => {
      // Drain the final RPC reply and startup diagnostic before settling exit.
      // A descendant retaining a pipe must not hold failure reporting forever.
      await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(1_000)])
      const detail = this.stderr.trim()
      const busy = /(?:^|\n)Error: Busy(?:\r?\n|$)/.test(detail)
      this.fail(
        new EngineError(
          busy ? "engine_busy" : "engine_closed",
          busy
            ? "miao-engine exited: native storage is owned by another running engine"
            : `miao-engine exited (code ${code})${detail ? `: ${detail}` : ""}`,
        ),
        true,
      )
      this.cleanup()
    })
  }

  static start(options: EngineOptions): EngineClient {
    const manifest = prepareMcpConfig(options)
    try {
      const args = engineArgs({ ...options, mcpConfigFile: manifest?.file ?? options.mcpConfigFile })
      const child = spawn([options.binary, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: engineEnvironment(options.env),
      })
      return new EngineClient(child, manifest?.dispose)
    } catch (error) {
      manifest?.dispose()
      throw error
    }
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

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new EngineError("engine_closed", "miao-engine client is closed"))
    const id = this.next++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + EOL)
        void Promise.resolve(this.child.stdin.flush()).catch(() => this.inputClosed())
      } catch {
        this.inputClosed()
      }
    })
  }

  get available() {
    return !this.closed && !this.failure
  }

  private inputClosed() {
    // EPIPE can beat process exit and otherwise permanently hide its stderr.
    // Still reject a live child that closed stdin instead of waiting forever.
    this.inputFailure ??= Promise.race([this.exited, Bun.sleep(1_500)]).then(() => {
      if (!this.failure) this.fail(new EngineError("engine_closed", "miao-engine input stream closed"), true)
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
    return this.request("shutdown")
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    try {
      await this.child.exited
    } finally {
      this.cleanup()
    }
  }

  private fail(error: Error, terminal = false) {
    if (terminal) this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure ?? error)
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
    // Unsupported or malformed RPCs can fail before the engine decodes an ID.
    // Such errors carry id:null; silently dropping them leaves every caller
    // waiting forever, notably when a product starts an older engine binary.
    if (message.error) {
      this.fail(new EngineError(message.error.code ?? "engine_error", message.error.message ?? "miao-engine error"))
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
