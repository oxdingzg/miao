import type { NativeInput } from "./command-manifest"
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
  /**
   * Headless callers that own the whole process lifetime (for example
   * `miao run`) set this so close() immediately signals the engine child.
   * Interactive hosts first request graceful shutdown of their stdio child.
   */
  ephemeral?: boolean
  /** Bound control-plane RPCs; model execution itself runs asynchronously. */
  requestTimeoutMs?: number

  binary: string
  db: string
  workspace: string
  model: string
  /** ADR-12 worker host config passed as `--worker-config`; absent keeps extension tools off. */
  workerConfigFile?: string
  provider?: string
  endpoint?: string
  /** Host-owned AWS SDK chain selection; credentials remain out of argv. */
  awsRegion?: string
  awsProfile?: string
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
  /** Trusted original registration digests for product-owned OAuth proxy routes. */
  mcpAuthorityRevisions?: Record<string, string>
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
  /** Host-owned product tool definitions the engine may reverse-dispatch. */
  productToolsFile?: string
  /** Plugin hook families the host resolves; a marker, never the callbacks. */
  pluginHooksFile?: string
  /**
   * Execute a product tool the engine planned. The reply becomes the tool
   * result, so a rejection must be thrown, never swallowed.
   */
  onProductTool?: (call: {
    sessionID: string
    name: string
    input: unknown
    callID: string
    /** Bridge routing key; the cancel notice carries it back. */
    bridgeID: number
    /** The calling assistant message's durable seq, when the engine reports it. */
    messageSeq?: number
  }) => Promise<unknown>
  /**
   * A run settled while this bridge call was still pending (cancel, failure,
   * or clean end). The executor must stop children and release the call; the
   * engine has already dropped the pending reply slot.
   */
  onProductToolCancel?: (call: { sessionID: string; bridgeID: number }) => void
  /**
   * Answer a reverse-dispatched plugin tool hook. The reply is the verdict:
   * `{ deny }` blocks, `{ args }` transforms the before input, `{ output }`
   * replaces the after result; a rejection fails the call closed.
   */
  onHookTool?: (call: {
    sessionID: string
    kind: "before" | "after" | "definition"
    tool: string
    callID: string
    args?: unknown
    output?: unknown
    /** The tool definition under review, for the `definition` family. */
    definition?: unknown
  }) => Promise<unknown>
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
  // Bedrock's AWS SDK default credential chain. Region/profile and bearer
  // selection also travel in the trusted route manifest when configured.
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_STS_REGIONAL_ENDPOINTS",
  "AWS_SDK_LOAD_CONFIG",
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
  // Dev diagnostic: request-body dump for prefix-cache divergence triage.
  // Dev diagnostic: request-body dump for prefix-cache divergence triage.
  "MIAO_ENGINE_REQUEST_DUMP",
  // Dev diagnostic: response-side per-request usage (cached_tokens) for
  // prefix-cache divergence triage.
  "MIAO_ENGINE_RESPONSE_DUMP",
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
  if (options.awsRegion) args.push("--aws-region", options.awsRegion)
  if (options.awsProfile) args.push("--aws-profile", options.awsProfile)
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
  if (options.productToolsFile) args.push("--product-tools", options.productToolsFile)
  if (options.pluginHooksFile) args.push("--plugin-hooks", options.pluginHooksFile)
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
    private readonly onProductTool?: EngineOptions["onProductTool"],
    private readonly onHookTool?: EngineOptions["onHookTool"],
    private readonly onProductToolCancel?: EngineOptions["onProductToolCancel"],
    private readonly ephemeral: boolean = false,
    private readonly requestTimeoutMs = 60_000,
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
        env: engineEnvironment({ ...manifest?.environment, ...options.env }),
      })
      return new EngineClient(
        child,
        manifest?.dispose,
        options.onProductTool,
        options.onHookTool,
        options.onProductToolCancel,
        options.ephemeral ?? false,
        options.requestTimeoutMs,
      )
    } catch (error) {
      manifest?.dispose()
      throw error
    }
  }

  onEvent(handler: (event: EngineEvent) => void) {
    this.eventHandlers.push(handler)
  }

  offEvent(handler: (event: EngineEvent) => void) {
    const index = this.eventHandlers.indexOf(handler)
    if (index >= 0) this.eventHandlers.splice(index, 1)
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
      const timeout = setTimeout(() => {
        this.fail(
          new EngineError(
            "engine_request_timeout",
            `miao-engine ${method} request timed out after ${this.requestTimeoutMs} ms; inspect its durable receipt before retrying`,
          ),
          true,
        )
        this.child.kill()
        const force = setTimeout(() => this.child.kill("SIGKILL"), 1_000)
        void this.child.exited.then(() => clearTimeout(force))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
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

  admit(
    input: NativeInput,
    resume = true,
    attachments: readonly { mime: string; data: string; metadata?: Readonly<Record<string, unknown>> }[] = [],
  ) {
    return this.request("admit", { input, resume, ...(attachments.length ? { attachments } : {}) })
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
    // This stdio child depends on its host for reverse tool calls. Detaching
    // it leaves active runs waiting for replies that can never arrive, and
    // inherited pipe descriptors can prevent stdin EOF indefinitely.
    this.fail(new EngineError("engine_closed", "miao-engine client is closed"), true)
    if (this.ephemeral) this.child.kill()
    if (!this.ephemeral) {
      await Promise.resolve()
        .then(() => {
          this.child.stdin.write(JSON.stringify({ id: this.next++, method: "shutdown" }) + EOL)
          void Promise.resolve(this.child.stdin.flush()).catch(() => {})
          this.child.stdin.end()
        })
        .catch(() => {})
    }
    const exited = await Promise.race([this.child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])
    if (!exited) {
      this.child.kill()
      const stopped = await Promise.race([this.child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])
      if (!stopped) this.child.kill("SIGKILL")
    }
    await this.exited
    this.cleanup()
  }

  private fail(error: Error, terminal = false) {
    if (terminal) this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure ?? error)
    this.pending.clear()
  }

  private dispatch(line: string) {
    const message = JSON.parse(line) as {
      id?: number
      bridge_id?: number
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
    if (message.method === "product_tool") {
      const bridgeID = message.bridge_id
      const params = message.params as
        | { session_id?: string; name?: string; input?: unknown; call_id?: unknown; message_seq?: unknown }
        | undefined
      const reply = (value: Record<string, unknown>) => this.child.stdin.write(JSON.stringify({ bridge_id: bridgeID, ...value }) + EOL)
      if (typeof bridgeID !== "number" || !params?.name || !this.onProductTool) {
        reply({ error: "product tool is not available on this host" })
        return
      }
      void this.onProductTool({
        sessionID: params.session_id ?? "",
        name: params.name,
        input: params.input,
        // Newer engines name the real provider call; older ones only have the
        // bridge routing key, which stays a stable fallback identity.
        callID: typeof params.call_id === "string" && params.call_id.length > 0 ? params.call_id : String(bridgeID),
        bridgeID,
        ...(typeof params.message_seq === "number" ? { messageSeq: params.message_seq } : {}),
      }).then(
        (result) => reply({ result }),
        (error) => reply({ error: error instanceof Error ? error.message : String(error) }),
      )
      return
    }
    if (message.method === "product_tool.cancel") {
      const bridgeID = message.bridge_id
      const params = message.params as { session_id?: string } | undefined
      if (typeof bridgeID === "number") this.onProductToolCancel?.({ sessionID: params?.session_id ?? "", bridgeID })
      return
    }
    if (message.method === "hook_tool") {
      const bridgeID = message.bridge_id
      const params = message.params as
        | {
            session_id?: string
            kind?: string
            tool?: string
            call_id?: string
            args?: unknown
            output?: unknown
            definition?: unknown
          }
        | undefined
      const reply = (value: Record<string, unknown>) =>
        this.child.stdin.write(JSON.stringify({ bridge_id: bridgeID, ...value }) + EOL)
      if (typeof bridgeID !== "number" || !params?.kind || !this.onHookTool) {
        reply({ error: "tool hooks are not available on this host" })
        return
      }
      void this.onHookTool({
        sessionID: params.session_id ?? "",
        kind: params.kind === "after" ? "after" : params.kind === "definition" ? "definition" : "before",
        tool: params.tool ?? "",
        callID: params.call_id ?? "",
        args: params.args,
        output: params.output,
        definition: params.definition,
      }).then(
        (result) => reply({ result }),
        (error) => reply({ error: error instanceof Error ? error.message : String(error) }),
      )
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
