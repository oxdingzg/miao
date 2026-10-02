// ACP agent backed only by the V2 protocol. Every operation is a call on the
// generated `@miao/client`, so this adapter can move out of process (or be
// replaced by another implementation) without touching the server.
import {
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type PermissionOption,
  type PlanEntry,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionModelRequest,
  type SetSessionModeRequest,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import {
  configOptions,
  defaultMode,
  defaultModel,
  DefaultVariant,
  findModel,
  hasVariant,
  initialVariant,
  parseModel,
  type Catalog,
  type ModelKey,
} from "./config"
import { promptFromContent, slashCommand, userContent } from "./content"
import { sessionNotFound, toRequestError } from "./error"
import { follow, type EventStream } from "./events"
import { editChanges } from "./preview"
import {
  completedToolUpdate,
  failedToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  toolKind,
  toolLocations,
  toolTitle,
  type ToolCallInfo,
  type ToolInput,
} from "./tool"
import type { Client, Event, EventOf, Message, Session, Todo } from "./types"

export const AuthMethodID = "opencode-login"

export type Options = {
  readonly client: Client
  readonly version: string
  readonly log?: (message: string) => void
}

type Turn = {
  readonly idle: PromiseWithResolvers<void>
  busy: boolean
  cancelled: boolean
  failure?: { readonly message: string; readonly name?: string }
  stepError?: string
  finish?: string
  context?: number
  tokens: { input: number; output: number; reasoning: number; read: number; write: number }
}

type State = {
  readonly id: string
  readonly cwd: string
  catalog: Catalog
  model?: ModelKey
  variant?: string
  mode?: string
  turn?: Turn
  /** Live tool calls by `messageID:callID`, so later events and permission asks can describe them. */
  readonly tools: Map<string, ToolCallInfo>
  /** Text and reasoning blocks that streamed deltas, so their end event does not resend the text. */
  readonly streamed: Set<string>
  /** Serializes interactive requests (permissions, questions) per session. */
  asking: Promise<void>
}

type PermissionRequest = EventOf<"permission.v2.asked">["data"]
type QuestionRequest = EventOf<"question.v2.asked">["data"]

const PageSize = 200
const permissionOptions: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

export class MiaoAgent implements Agent {
  private readonly sessions = new Map<string, State>()
  private readonly catalogs = new Map<string, Promise<Catalog>>()
  /** Child Session ID → the tracked root that asks on its behalf (undefined when none is tracked). */
  private readonly owners = new Map<string, Promise<State | undefined>>()
  private stream: EventStream | undefined
  private readonly client: Client
  private readonly log: (message: string) => void
  private capabilities: ClientCapabilities | undefined

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly options: Options,
  ) {
    this.client = options.client
    this.log = options.log ?? ((message) => console.error(message))
  }

  /** The connection is not usable while the SDK constructs this agent, so the stream starts on first use. */
  private get events() {
    this.stream ??= follow({
      client: this.client,
      signal: this.connection.signal,
      handle: (event) => this.dispatch(event),
      log: this.log,
    })
    return this.stream
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.capabilities = params.clientCapabilities ?? undefined
    void this.events
    const terminalAuth = params.clientCapabilities?._meta?.["terminal-auth"] === true
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        // ACP-provided MCP servers are not wired into V2 yet (no runtime MCP registration); stdio
        // servers are accepted and ignored, remote transports are not advertised.
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
      authMethods: [
        {
          id: AuthMethodID,
          name: "Login with miao",
          description: "Run `miao auth login` in the terminal",
          ...(terminalAuth
            ? { _meta: { "terminal-auth": { command: "miao", args: ["auth", "login"], label: "miao Login" } } }
            : {}),
        },
      ],
      agentInfo: { name: "OpenCode", version: this.options.version },
    }
  }

  async authenticate(params: AuthenticateRequest) {
    if (params.methodId !== AuthMethodID)
      throw RequestError.invalidParams({ methodId: params.methodId }, `unknown auth method: ${params.methodId}`)
    return {}
  }

  newSession(params: NewSessionRequest) {
    return guard(async () => {
      this.ignoreMcp(params.mcpServers)
      const catalog = await this.catalog(params.cwd)
      const model = defaultModel(catalog)
      const variant = model ? initialVariant(catalog, model) : undefined
      const session = await this.client.sessions.create({
        location: { directory: params.cwd },
        ...(model ? { model: modelRef(model, variant) } : {}),
      })
      const state = this.track(session, catalog, { model, variant })
      this.announceCommands(state)
      return { sessionId: state.id, configOptions: this.currentOptions(state) }
    })
  }

  loadSession(params: LoadSessionRequest) {
    return guard(async () => {
      this.ignoreMcp(params.mcpServers)
      const state = await this.open(params.sessionId, params.cwd)
      await this.replay(state)
      this.announceCommands(state)
      void this.askPending(state)
      return { configOptions: this.currentOptions(state) }
    })
  }

  resumeSession(params: ResumeSessionRequest) {
    return guard(async () => {
      this.ignoreMcp(params.mcpServers ?? [])
      const state = await this.open(params.sessionId, params.cwd)
      this.announceCommands(state)
      void this.askPending(state)
      return { configOptions: this.currentOptions(state) }
    })
  }

  unstable_forkSession(params: ForkSessionRequest) {
    return guard(async () => {
      this.ignoreMcp(params.mcpServers ?? [])
      const forked = await this.client.sessions.fork({ sessionID: params.sessionId })
      const state = this.track(forked, await this.catalog(forked.location.directory || params.cwd))
      await this.replay(state)
      this.announceCommands(state)
      return { sessionId: state.id, configOptions: this.currentOptions(state) }
    })
  }

  listSessions(params: ListSessionsRequest) {
    return guard(async (): Promise<ListSessionsResponse> => {
      const page = await this.client.sessions.list({
        ...(params.cwd ? { directory: params.cwd } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        limit: 100,
      })
      return {
        // Subagent sessions are reached through their parent, as in the TUI.
        sessions: page.data
          .filter((session) => !session.parentID)
          .map((session) => ({
            sessionId: session.id,
            cwd: session.location.directory,
            title: session.title,
            updatedAt: new Date(session.time.updated).toISOString(),
          })),
        ...(page.data.length === 100 && page.cursor.next ? { nextCursor: page.cursor.next } : {}),
      }
    })
  }

  closeSession(params: CloseSessionRequest) {
    return guard(async () => {
      const state = this.sessions.get(params.sessionId)
      this.sessions.delete(params.sessionId)
      if (state?.turn) await this.client.sessions.interrupt({ sessionID: state.id }).catch(() => undefined)
      return {}
    })
  }

  cancel(params: CancelNotification) {
    return guard(async () => {
      const state = this.require(params.sessionId)
      if (state.turn) state.turn.cancelled = true
      await this.client.sessions.interrupt({ sessionID: state.id })
    })
  }

  setSessionMode(params: SetSessionModeRequest) {
    return guard(async () => {
      const state = this.require(params.sessionId)
      await this.switchMode(state, params.modeId)
      return {}
    })
  }

  unstable_setSessionModel(params: SetSessionModelRequest) {
    return guard(async () => {
      const state = this.require(params.sessionId)
      await this.switchModel(state, params.modelId)
      await this.notify(state.id, { sessionUpdate: "config_option_update", configOptions: this.currentOptions(state) })
      return {}
    })
  }

  setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    return guard(async () => {
      const state = this.require(params.sessionId)
      const value = params.value
      if (typeof value !== "string")
        throw RequestError.invalidParams({ configId: params.configId }, `unknown config option: ${params.configId}`)
      if (params.configId === "model") {
        await this.switchModel(state, value)
        const configOptions = this.currentOptions(state)
        await this.notify(state.id, { sessionUpdate: "config_option_update", configOptions })
        return { configOptions }
      }
      if (params.configId === "effort") {
        if (!state.model || !hasVariant(state.catalog, state.model, value))
          throw RequestError.invalidParams({ effort: value }, `effort not found: ${value}`)
        await this.client.sessions.switchModel({ sessionID: state.id, model: modelRef(state.model, value) })
        state.variant = value
        return { configOptions: this.currentOptions(state) }
      }
      if (params.configId === "mode") {
        await this.switchMode(state, value)
        return { configOptions: this.currentOptions(state) }
      }
      throw RequestError.invalidParams({ configId: params.configId }, `unknown config option: ${params.configId}`)
    })
  }

  prompt(params: PromptRequest) {
    return guard(async (): Promise<PromptResponse> => {
      const state = this.require(params.sessionId)
      const prompt = promptFromContent(params.prompt)
      const command = slashCommand(prompt)
      const known = command ? state.catalog.commands.find((item) => item.name === command.name) : undefined
      const turn = await this.turn(state, async () => {
        if (command && known?.kind === "command")
          return this.client.sessions.command({ sessionID: state.id, command: known.name, arguments: command.args })
        if (command && known?.kind === "skill") {
          // A skill only injects its instructions (a wake without new input does not run), so the
          // rest of the line, or the slash command itself, becomes the prompt that uses them.
          await this.client.sessions.skill({ sessionID: state.id, skill: known.name, resume: false })
          return this.client.sessions.prompt({ sessionID: state.id, prompt: { text: command.args || prompt.text } })
        }
        if (command?.name === "compact") return this.client.sessions.compact({ sessionID: state.id })
        return this.client.sessions.prompt({ sessionID: state.id, prompt })
      })
      await this.sendUsage(state, turn)
      return {
        stopReason: stopReason(turn),
        usage: {
          inputTokens: turn.tokens.input,
          outputTokens: turn.tokens.output,
          totalTokens:
            turn.tokens.input + turn.tokens.output + turn.tokens.reasoning + turn.tokens.read + turn.tokens.write,
          ...(turn.tokens.reasoning > 0 ? { thoughtTokens: turn.tokens.reasoning } : {}),
          ...(turn.tokens.read > 0 ? { cachedReadTokens: turn.tokens.read } : {}),
          ...(turn.tokens.write > 0 ? { cachedWriteTokens: turn.tokens.write } : {}),
        },
        ...(params.messageId ? { userMessageId: params.messageId } : {}),
        _meta: {},
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Sessions

  private require(sessionId: string) {
    const state = this.sessions.get(sessionId)
    if (!state) throw sessionNotFound(sessionId)
    return state
  }

  private async open(sessionId: string, cwd: string) {
    const session = await this.client.sessions.get({ sessionID: sessionId })
    return this.track(session, await this.catalog(session.location.directory || cwd))
  }

  private track(session: Session, catalog: Catalog, selected?: { model?: ModelKey; variant?: string }) {
    void this.events
    const durable = session.model ? { providerID: session.model.providerID, id: session.model.id } : undefined
    const model = selected?.model ?? durable ?? defaultModel(catalog)
    const state: State = {
      id: session.id,
      cwd: session.location.directory,
      catalog,
      model,
      // A durable model without a variant runs without an override, which the effort option shows as `default`.
      variant: selected ? selected.variant : session.model ? (session.model.variant ?? DefaultVariant) : undefined,
      mode: session.agent ?? defaultMode(catalog),
      tools: new Map(),
      streamed: new Set(),
      asking: Promise.resolve(),
    }
    this.sessions.set(state.id, state)
    return state
  }

  private currentOptions(state: State) {
    if (!state.model) return []
    return configOptions(state.catalog, { model: state.model, variant: state.variant, mode: state.mode })
  }

  private async switchMode(state: State, mode: string) {
    if (!state.catalog.modes.some((item) => item.id === mode))
      throw RequestError.invalidParams({ mode }, `mode not found: ${mode}`)
    await this.client.sessions.switchAgent({ sessionID: state.id, agent: mode })
    state.mode = mode
  }

  private async switchModel(state: State, value: string) {
    const parsed = parseModel(value, state.catalog)
    if (!parsed) throw RequestError.invalidParams({ modelId: value }, `model not found: ${value}`)
    const same = state.model?.providerID === parsed.model.providerID && state.model.id === parsed.model.id
    const variant =
      parsed.variant ??
      (same && state.variant && hasVariant(state.catalog, parsed.model, state.variant)
        ? state.variant
        : initialVariant(state.catalog, parsed.model))
    await this.client.sessions.switchModel({ sessionID: state.id, model: modelRef(parsed.model, variant) })
    state.model = parsed.model
    state.variant = variant
  }

  private catalog(directory: string) {
    const cached = this.catalogs.get(directory)
    if (cached) return cached
    const loaded = loadCatalog(this.client, directory)
    this.catalogs.set(directory, loaded)
    loaded.catch(() => this.catalogs.delete(directory))
    return loaded
  }

  private ignoreMcp(servers: ReadonlyArray<McpServer>) {
    if (servers.length === 0) return
    this.log(
      `acp: ignoring ${servers.length} MCP server(s) from the client (${servers.map((server) => server.name).join(", ")}); ` +
        "configure them in miao's own mcp config instead",
    )
  }

  private announceCommands(state: State) {
    // Sent after the response so clients that create their session view on the response still receive it.
    setTimeout(() => {
      void this.notify(state.id, {
        sessionUpdate: "available_commands_update",
        availableCommands: state.catalog.commands.map((command) => ({
          name: command.name,
          description: command.description,
        })),
      })
    }, 0)
  }

  // ---------------------------------------------------------------------------
  // Turns

  /**
   * Starts work and resolves when the Session is idle again. Completion is the
   * `idle` status event, which follows every event of the drain on the stream;
   * `sessions.wait` is the fallback for a stream that dropped the event.
   */
  private async turn(state: State, start: () => Promise<unknown>) {
    await Promise.race([this.events.connected, Bun.sleep(5000)])
    const turn: Turn = {
      idle: Promise.withResolvers<void>(),
      busy: false,
      cancelled: false,
      tokens: { input: 0, output: 0, reasoning: 0, read: 0, write: 0 },
    }
    state.turn = turn
    const settled = async () => {
      await this.client.sessions.wait({ sessionID: state.id })
      await Promise.race([turn.idle.promise, Bun.sleep(2000)])
    }
    try {
      await start()
      await Promise.race([turn.idle.promise, settled().catch(() => turn.idle.promise)])
    } finally {
      if (state.turn === turn) state.turn = undefined
    }
    // A declined permission or an interrupt halts the drain without settling the tool that
    // was waiting; close those calls so the client does not show them running.
    for (const info of state.tools.values())
      await this.notify(state.id, {
        sessionUpdate: "tool_call_update",
        ...failedToolUpdate(info, turn.cancelled ? "Cancelled" : "Stopped before the tool finished"),
      })
    state.tools.clear()
    return turn
  }

  private async sendUsage(state: State, turn: Turn) {
    const size = findModel(state.catalog, state.model)?.context
    if (!size || turn.context === undefined) return
    const session = await this.client.sessions.get({ sessionID: state.id }).catch(() => undefined)
    await this.notify(state.id, {
      sessionUpdate: "usage_update",
      used: turn.context,
      size,
      ...(session ? { cost: { amount: session.cost, currency: "USD" } } : {}),
    })
  }

  // ---------------------------------------------------------------------------
  // Replay

  private async replay(state: State) {
    const pages = async (cursor?: string): Promise<void> => {
      const page = await this.client.messages.list({
        sessionID: state.id,
        limit: PageSize,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      })
      for (const message of page.data) await this.replayMessage(state, message)
      if (page.data.length === PageSize && page.cursor.next) return pages(page.cursor.next)
    }
    await pages()
    const todos = await this.client.sessions.todo({ sessionID: state.id }).catch(() => [])
    if (todos.length > 0) await this.notify(state.id, { sessionUpdate: "plan", entries: planEntries(todos) })
  }

  private async replayMessage(state: State, message: Message) {
    if (message.type === "user") {
      for (const chunk of userContent(message))
        await this.notify(state.id, { sessionUpdate: "user_message_chunk", messageId: message.id, ...chunk })
      return
    }
    if (message.type === "synthetic") {
      await this.notify(state.id, {
        sessionUpdate: "user_message_chunk",
        messageId: message.id,
        content: { type: "text", text: message.text, annotations: { audience: ["assistant"] } },
      })
      return
    }
    if (message.type === "shell") {
      const info = {
        callID: `${message.id}:${message.callID}`,
        name: "bash",
        input: { command: message.command },
        cwd: state.cwd,
      }
      await this.notify(state.id, { sessionUpdate: "tool_call", ...pendingToolCall(info) })
      await this.notify(state.id, {
        sessionUpdate: "tool_call_update",
        ...completedToolUpdate(info, [{ type: "text", text: message.output }]),
      })
      return
    }
    if (message.type !== "assistant") return
    for (const item of message.content) {
      if (item.type === "text") {
        if (item.text)
          await this.notify(state.id, {
            sessionUpdate: "agent_message_chunk",
            messageId: message.id,
            content: { type: "text", text: item.text },
          })
        continue
      }
      if (item.type === "reasoning") {
        if (item.text)
          await this.notify(state.id, {
            sessionUpdate: "agent_thought_chunk",
            messageId: message.id,
            content: { type: "text", text: item.text },
          })
        continue
      }
      const info: ToolCallInfo = {
        callID: `${message.id}:${item.id}`,
        name: item.name,
        input: item.state.status === "pending" ? parseInput(item.state.input) : item.state.input,
        cwd: state.cwd,
      }
      await this.notify(state.id, { sessionUpdate: "tool_call", ...pendingToolCall(info) })
      const update =
        item.state.status === "completed"
          ? completedToolUpdate(info, item.state.content, {
              structured: item.state.structured,
              result: item.state.result,
            })
          : item.state.status === "error"
            ? failedToolUpdate(info, item.state.error.message)
            : item.state.status === "running"
              ? runningToolUpdate(info, item.state.content)
              : undefined
      if (update) await this.notify(state.id, { sessionUpdate: "tool_call_update", ...update })
    }
  }

  // ---------------------------------------------------------------------------
  // Live events

  private async dispatch(event: Event) {
    if (event.type === "permission.v2.asked")
      return this.enqueue(event.data.sessionID, (state) => this.permission(state, event.data))
    if (event.type === "question.v2.asked")
      return this.enqueue(event.data.sessionID, (state) => this.question(state, event.data))
    if (event.type === "todo.updated") {
      const state = this.sessions.get(event.data.sessionID)
      if (state) await this.notify(state.id, { sessionUpdate: "plan", entries: planEntries(event.data.todos) })
      return
    }
    const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
    if (!event.type.startsWith("session.next.") || typeof sessionID !== "string") return
    const state = this.sessions.get(sessionID)
    if (state) await this.live(state, event)
  }

  private async live(state: State, event: Event) {
    const turn = state.turn
    switch (event.type) {
      case "session.next.status":
        if (!turn) return
        if (event.data.status.type === "busy") turn.busy = true
        if (event.data.status.type === "idle" && turn.busy) turn.idle.resolve()
        return
      case "session.next.failed":
        if (turn) turn.failure = { message: event.data.error.message, name: event.data.name }
        return
      case "session.next.step.failed":
        if (turn) turn.stepError = event.data.error.message
        return
      case "session.next.step.ended":
        if (!turn) return
        turn.finish = event.data.finish
        turn.context = event.data.tokens.input + event.data.tokens.cache.read + event.data.tokens.cache.write
        turn.tokens.input += event.data.tokens.input
        turn.tokens.output += event.data.tokens.output
        turn.tokens.reasoning += event.data.tokens.reasoning
        turn.tokens.read += event.data.tokens.cache.read
        turn.tokens.write += event.data.tokens.cache.write
        return
      case "session.next.text.delta":
        state.streamed.add(`${event.data.assistantMessageID}:${event.data.textID}`)
        return this.notify(state.id, {
          sessionUpdate: "agent_message_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.delta },
        })
      case "session.next.text.ended":
        if (state.streamed.delete(`${event.data.assistantMessageID}:${event.data.textID}`) || !event.data.text) return
        return this.notify(state.id, {
          sessionUpdate: "agent_message_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.text },
        })
      case "session.next.reasoning.delta":
        state.streamed.add(`${event.data.assistantMessageID}:${event.data.reasoningID}`)
        return this.notify(state.id, {
          sessionUpdate: "agent_thought_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.delta },
        })
      case "session.next.reasoning.ended":
        if (state.streamed.delete(`${event.data.assistantMessageID}:${event.data.reasoningID}`) || !event.data.text)
          return
        return this.notify(state.id, {
          sessionUpdate: "agent_thought_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.text },
        })
      case "session.next.tool.input.started": {
        const info = { callID: toolKey(event.data), name: event.data.name, input: {}, cwd: state.cwd }
        state.tools.set(info.callID, info)
        return this.notify(state.id, { sessionUpdate: "tool_call", ...pendingToolCall(info) })
      }
      case "session.next.tool.called": {
        const started = state.tools.has(toolKey(event.data))
        const info = { callID: toolKey(event.data), name: event.data.tool, input: event.data.input, cwd: state.cwd }
        state.tools.set(info.callID, info)
        if (!started) await this.notify(state.id, { sessionUpdate: "tool_call", ...pendingToolCall(info) })
        return this.notify(state.id, { sessionUpdate: "tool_call_update", ...runningToolUpdate(info) })
      }
      case "session.next.tool.progress": {
        const info = state.tools.get(toolKey(event.data))
        if (!info) return
        return this.notify(state.id, {
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate(info, event.data.content),
        })
      }
      case "session.next.tool.success": {
        const info = this.settleTool(state, event.data)
        return this.notify(state.id, {
          sessionUpdate: "tool_call_update",
          ...describe(
            info,
            completedToolUpdate(info.call, event.data.content, {
              structured: event.data.structured,
              result: event.data.result,
            }),
          ),
        })
      }
      case "session.next.tool.failed": {
        const info = this.settleTool(state, event.data)
        return this.notify(state.id, {
          sessionUpdate: "tool_call_update",
          ...describe(info, failedToolUpdate(info.call, event.data.error.message)),
        })
      }
      case "session.next.shell.started": {
        const info = {
          callID: `shell:${event.data.callID}`,
          name: "bash",
          input: { command: event.data.command },
          cwd: state.cwd,
        }
        await this.notify(state.id, { sessionUpdate: "tool_call", ...pendingToolCall(info) })
        return this.notify(state.id, { sessionUpdate: "tool_call_update", ...runningToolUpdate(info) })
      }
      case "session.next.shell.ended": {
        const info = { callID: `shell:${event.data.callID}`, name: "bash", input: {}, cwd: state.cwd }
        return this.notify(state.id, {
          sessionUpdate: "tool_call_update",
          ...completedToolUpdate(info, [{ type: "text", text: event.data.output }]),
        })
      }
      case "session.next.info.updated":
        if (event.data.title === undefined) return
        return this.notify(state.id, {
          sessionUpdate: "session_info_update",
          title: event.data.title,
          updatedAt: new Date(event.data.timestamp).toISOString(),
        })
      case "session.next.agent.switched":
        if (state.mode === event.data.agent) return
        state.mode = event.data.agent
        return this.notify(state.id, { sessionUpdate: "current_mode_update", currentModeId: event.data.agent })
      case "session.next.model.switched": {
        const variant = event.data.model.variant ?? DefaultVariant
        if (
          state.model?.providerID === event.data.model.providerID &&
          state.model.id === event.data.model.id &&
          state.variant === variant
        )
          return
        state.model = { providerID: event.data.model.providerID, id: event.data.model.id }
        state.variant = variant
        return this.notify(state.id, {
          sessionUpdate: "config_option_update",
          configOptions: this.currentOptions(state),
        })
      }
      default:
        return
    }
  }

  private settleTool(state: State, data: { readonly assistantMessageID: string; readonly callID: string }) {
    const key = toolKey(data)
    const known = state.tools.get(key)
    state.tools.delete(key)
    return { call: known ?? { callID: key, name: "", input: {}, cwd: state.cwd }, known: known !== undefined }
  }

  // ---------------------------------------------------------------------------
  // Permissions and questions

  /** Runs an interactive request for a tracked Session, or for a subagent Session whose root is tracked. */
  private async enqueue(sessionID: string, ask: (state: State) => Promise<void>) {
    const state = await this.owner(sessionID)
    if (!state) return
    // Not awaited: the user's answer must not hold up the event stream.
    state.asking = state.asking
      .then(() => ask(state))
      .catch((error: unknown) => this.log(`acp: request: ${String(error)}`))
  }

  private owner(sessionID: string): Promise<State | undefined> {
    const tracked = this.sessions.get(sessionID)
    if (tracked) return Promise.resolve(tracked)
    const cached = this.owners.get(sessionID)
    if (cached) return cached
    const resolved = this.client.sessions
      .get({ sessionID })
      .then((session) => (session.parentID ? this.owner(session.parentID) : undefined))
      .catch(() => undefined)
    this.owners.set(sessionID, resolved)
    return resolved
  }

  private async askPending(state: State) {
    const pending = await this.client.permissions.list({ sessionID: state.id }).catch(() => [])
    for (const request of pending) await this.enqueue(state.id, (owner) => this.permission(owner, request))
  }

  private async permission(state: State, request: PermissionRequest) {
    const key = request.source ? `${request.source.messageID}:${request.source.callID}` : undefined
    const tool = key ? state.tools.get(key) : undefined
    const metadata = (request.metadata ?? {}) as ToolInput
    const changes = request.action === "edit" ? await editChanges(metadata, state.cwd).catch(() => []) : []
    const toolCall: ToolCallUpdate = {
      toolCallId: key ?? request.id,
      title: tool ? toolTitle(tool.name, tool.input) : permissionTitle(request),
      kind: toolKind(tool?.name ?? request.action),
      status: "pending",
      locations:
        changes.length > 0
          ? changes.map((change) => ({ path: change.path }))
          : tool
            ? toolLocations(tool.name, tool.input, state.cwd)
            : [],
      rawInput: tool?.input ?? metadata,
      ...(changes.length > 0
        ? {
            content: changes.map((change) => ({
              type: "diff" as const,
              path: change.path,
              oldText: change.oldText,
              newText: change.newText,
            })),
          }
        : {}),
    }
    const result = await this.connection
      .requestPermission({ sessionId: state.id, toolCall, options: permissionOptions })
      .catch(() => undefined)
    const reply =
      result?.outcome.outcome === "selected" &&
      (result.outcome.optionId === "once" || result.outcome.optionId === "always")
        ? result.outcome.optionId
        : "reject"
    // Show the approved edit in the editor; the tool still writes the file itself.
    if (reply !== "reject" && this.capabilities?.fs?.writeTextFile)
      changes.forEach((change) => {
        void this.connection
          .writeTextFile({ sessionId: state.id, path: change.path, content: change.newText })
          .catch(() => undefined)
      })
    await this.client.permissions
      .reply({ sessionID: request.sessionID, requestID: request.id, reply })
      .catch((error: unknown) => this.log(`acp: permission reply ${request.id}: ${String(error)}`))
  }

  /**
   * ACP has no question request, so single-choice questions are asked as a
   * permission prompt whose options are the answers. Anything else, or a
   * dismissed prompt, rejects the question so the turn can continue.
   */
  private async question(state: State, request: QuestionRequest) {
    const reject = () =>
      this.client.questions
        .reject({ sessionID: request.sessionID, requestID: request.id })
        .catch((error: unknown) => this.log(`acp: question reject ${request.id}: ${String(error)}`))
    if (request.questions.some((question) => question.multiSelect)) return reject()
    const answers: string[][] = []
    for (const [index, question] of request.questions.entries()) {
      const result = await this.connection
        .requestPermission({
          sessionId: state.id,
          toolCall: {
            toolCallId: request.tool ? `${request.tool.messageID}:${request.tool.callID}` : `${request.id}:${index}`,
            title: question.question,
            kind: "other",
            status: "pending",
          },
          options: [
            ...question.options.map((option, choice) => ({
              optionId: String(choice),
              name: option.description ? `${option.label} — ${option.description}` : option.label,
              kind: "allow_once" as const,
            })),
            { optionId: "reject", name: "Dismiss", kind: "reject_once" as const },
          ],
        })
        .catch(() => undefined)
      const choice =
        result?.outcome.outcome === "selected" ? question.options[Number(result.outcome.optionId)] : undefined
      if (!choice) return reject()
      answers.push([choice.label])
    }
    await this.client.questions
      .reply({ sessionID: request.sessionID, requestID: request.id, answers })
      .catch((error: unknown) => this.log(`acp: question reply ${request.id}: ${String(error)}`))
  }

  private notify(sessionId: string, update: SessionNotification["update"]) {
    return this.connection.sessionUpdate({ sessionId, update }).catch(() => undefined)
  }
}

async function loadCatalog(client: Client, directory: string): Promise<Catalog> {
  const location = { location: { directory } }
  const [models, providers, agents, commands, skills, fallback] = await Promise.all([
    client.models.list(location),
    client.providers.list(location),
    client.agents.list(location),
    client.commands.list(location),
    client.skills.list(location),
    client.models.default(location),
  ])
  const names = new Map(providers.data.map((provider) => [provider.id, provider.name]))
  const modes = agents.data
    .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
    .map((agent) => ({
      id: agent.id,
      name: agent.id,
      ...(agent.description ? { description: agent.description } : {}),
    }))
  return {
    directory,
    models: models.data.map((model) => ({
      providerID: model.providerID,
      providerName: names.get(model.providerID) ?? model.providerID,
      id: model.id,
      name: model.name,
      variants: model.variants.map((variant) => variant.id),
      context: model.limit.context,
    })),
    modes,
    defaultMode: modes.find((mode) => mode.id === "build")?.id ?? modes[0]?.id,
    commands: [
      ...commands.data.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        kind: "command" as const,
      })),
      ...skills.data
        .filter((skill) => !commands.data.some((command) => command.name === skill.name))
        .map((skill) => ({ name: skill.name, description: skill.description ?? "", kind: "skill" as const })),
    ].toSorted((a, b) => a.name.localeCompare(b.name)),
    ...(fallback.data ? { defaultModel: { providerID: fallback.data.providerID, id: fallback.data.id } } : {}),
  }
}

async function guard<A>(run: () => Promise<A>): Promise<A> {
  return run().catch((error: unknown) => {
    throw toRequestError(error)
  })
}

function stopReason(turn: Turn): PromptResponse["stopReason"] {
  if (turn.cancelled) return "cancelled"
  if (turn.failure)
    throw RequestError.internalError(
      { ...(turn.failure.name ? { errorName: turn.failure.name } : {}) },
      turn.failure.message,
    )
  if (turn.stepError) throw RequestError.internalError({}, turn.stepError)
  if (turn.finish === "length") return "max_tokens"
  if (turn.finish === "content-filter" || turn.finish === "content_filter") return "refusal"
  return "end_turn"
}

function modelRef(model: ModelKey, variant: string | undefined) {
  return {
    providerID: model.providerID,
    id: model.id,
    ...(variant && variant !== DefaultVariant ? { variant } : {}),
  }
}

/**
 * A settlement for a call this connection never saw start (a turn already running when the
 * session was opened, or one closed locally) keeps the client's own title and kind.
 */
function describe(info: { readonly known: boolean }, update: ToolCallUpdate): ToolCallUpdate {
  if (info.known) return update
  return { toolCallId: update.toolCallId, status: update.status, content: update.content, rawOutput: update.rawOutput }
}

function toolKey(data: { readonly assistantMessageID: string; readonly callID: string }) {
  return `${data.assistantMessageID}:${data.callID}`
}

/** A pending tool call stores the raw streamed input, which may be incomplete JSON. */
function parseInput(raw: string): ToolInput {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolInput) : {}
}

function planEntries(todos: ReadonlyArray<Todo>): PlanEntry[] {
  return todos
    .filter((todo) => todo.status !== "cancelled")
    .map((todo) => ({
      content: todo.content,
      status: todo.status === "in_progress" || todo.status === "completed" ? todo.status : "pending",
      priority: todo.priority === "high" || todo.priority === "low" ? todo.priority : "medium",
    }))
}

function permissionTitle(request: PermissionRequest) {
  const metadata = request.metadata ?? {}
  const detail =
    typeof metadata.command === "string"
      ? metadata.command
      : typeof metadata.filepath === "string"
        ? metadata.filepath
        : request.resources.join(", ")
  return detail ? `${request.action}: ${detail}` : request.action
}
