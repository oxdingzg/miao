import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type LLMRequest,
  type MediaPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { isContextOverflow } from "../provider-error"
import { InvalidRequestReason, LLMError } from "../schema/errors"

const ADAPTER = "commandcode"
export const DEFAULT_BASE_URL = "https://api.commandcode.ai"
export const PATH = "/alpha/generate"
const DEFAULT_MAX_TOKENS = 64_000
/**
 * Value sent as `x-command-code-version`. The harness rejects requests that
 * look like a proxy, so this must track a shipped `command-code` CLI release.
 */
export const CLI_VERSION = "1.74.1"

const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)

// =============================================================================
// Request Body Schema
// =============================================================================
// Command Code's `/alpha/generate` is the endpoint the `command-code` CLI uses
// for a subscription login (not the OpenAI/Anthropic-compatible Provider API).
// One route serves every model; the model id lives in `params.model`, together
// with a `config` snapshot of the working tree that gives the harness context.
const CommandCodeConfig = Schema.Struct({
  workingDir: Schema.String,
  date: Schema.String,
  environment: Schema.String,
  structure: Schema.Array(Schema.String),
  isGitRepo: Schema.Boolean,
  currentBranch: Schema.String,
  mainBranch: Schema.String,
  gitStatus: Schema.String,
  recentCommits: Schema.Array(Schema.String),
})

const CommandCodeContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), image: Schema.String, mimeType: optionalNull(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    output: Schema.Struct({ type: Schema.Literal("text"), value: Schema.String }),
  }),
])

const CommandCodeMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(CommandCodeContent) }),
  Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(CommandCodeContent) }),
  Schema.Struct({ role: Schema.Literal("tool"), content: Schema.Array(CommandCodeContent) }),
])
type CommandCodeMessage = Schema.Schema.Type<typeof CommandCodeMessage>

const CommandCodeSystemPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: Schema.optional(Schema.Struct({ type: Schema.Literal("ephemeral") })),
})

const CommandCodeTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: JsonObject,
})

export const bodyFields = {
  config: CommandCodeConfig,
  memory: Schema.NullOr(Schema.Unknown),
  taste: Schema.NullOr(Schema.Unknown),
  skills: Schema.NullOr(Schema.Unknown),
  permissionMode: Schema.String,
  threadId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  promptCache: Schema.optional(Schema.Unknown),
  params: Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(CommandCodeMessage),
    tools: optionalArray(CommandCodeTool),
    system: Schema.Union([Schema.String, Schema.Array(CommandCodeSystemPart)]),
    max_tokens: Schema.Number,
    stream: Schema.Literal(true),
    temperature: Schema.optional(Schema.Number),
    reasoning_effort: Schema.optional(Schema.String),
  }),
}
const CommandCodeBody = Schema.Struct(bodyFields)
export type CommandCodeBody = Schema.Schema.Type<typeof CommandCodeBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// `/alpha/generate` answers with newline-delimited JSON: one event object per
// line, carrying the AI SDK full-stream event vocabulary (`text-start`,
// `reasoning-delta`, `tool-call`, `finish-step`, `finish`, ...). Unknown event
// types are ignored, so the schema is permissive: every field is optional and
// unmodeled keys are tolerated.
const CommandCodeUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  inputTokenDetails: optionalNull(
    Schema.Struct({
      noCacheTokens: Schema.optional(Schema.Number),
      cacheReadTokens: Schema.optional(Schema.Number),
      cacheWriteTokens: Schema.optional(Schema.Number),
    }),
  ),
  outputTokenDetails: optionalNull(
    Schema.Struct({
      textTokens: Schema.optional(Schema.Number),
      reasoningTokens: Schema.optional(Schema.Number),
    }),
  ),
})

const CommandCodeEvent = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  providerExecuted: Schema.optional(Schema.Boolean),
  finishReason: Schema.optional(Schema.String),
  rawFinishReason: Schema.optional(Schema.String),
  usage: Schema.optional(CommandCodeUsage),
  totalUsage: Schema.optional(CommandCodeUsage),
  error: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})
type CommandCodeEvent = Schema.Schema.Type<typeof CommandCodeEvent>
type CommandCodeRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly lifecycle: Lifecycle.State
  readonly usage?: Usage
  readonly finishReason?: FinishReason
  readonly finished: boolean
}

const commandCodeOptions = (request: LLMRequest) => request.providerOptions?.commandcode ?? {}

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition) => ({
  name: tool.name,
  description: tool.description,
  input_schema: ToolSchemaProjection.openAI(tool.inputSchema),
})

const lowerMedia = Effect.fn("CommandCode.lowerMedia")(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia("Command Code", part, IMAGE_MIMES)
  return { type: "image" as const, image: ProviderShared.mediaDataUrl(media), mimeType: media.mime }
})

const lowerAssistantMessage = Effect.fn("CommandCode.lowerAssistantMessage")(function* (
  message: CommandCodeRequestMessage,
) {
  const content: Array<Schema.Schema.Type<typeof CommandCodeContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "reasoning") {
      content.push({ type: "reasoning", text: part.text })
      continue
    }
    if (part.type === "tool-call") {
      // Provider-executed calls already ran upstream; replaying them would ask
      // the model to call again.
      if (part.providerExecuted) continue
      content.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input })
      continue
    }
    return yield* ProviderShared.unsupportedContent("Command Code", "assistant", ["text", "reasoning", "tool-call"])
  }
  return content.length === 0 ? undefined : { role: "assistant" as const, content }
})

const lowerUserMessage = Effect.fn("CommandCode.lowerUserMessage")(function* (message: CommandCodeRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof CommandCodeContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("Command Code", "user", ["text", "media"])
  }
  return content.length === 0 ? undefined : { role: "user" as const, content }
})

const lowerToolMessage = Effect.fn("CommandCode.lowerToolMessage")(function* (message: CommandCodeRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof CommandCodeContent>> = []
  const images: Array<Schema.Schema.Type<typeof CommandCodeContent>> = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("Command Code", "tool", ["tool-result"])
    // The subscription endpoint accepts text tool outputs. Carry files in a
    // following user message, never JSON-stringify image bytes into text.
    const items: ReadonlyArray<ToolContent> = part.result.type === "content" ? part.result.value : []
    const value =
      part.result.type === "content"
        ? items
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n")
        : ProviderShared.toolResultText(part)
    if (part.result.type === "content") {
      for (const item of items) {
        if (item.type !== "file") continue
        images.push(yield* lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name }))
      }
    }
    content.push({
      type: "tool-result",
      toolCallId: part.id,
      toolName: part.name,
      output: { type: "text" as const, value },
    })
  }
  return { message: content.length === 0 ? undefined : { role: "tool" as const, content }, images }
})

const lowerMessages = Effect.fn("CommandCode.lowerMessages")(function* (request: LLMRequest) {
  const messages: Array<CommandCodeMessage> = []
  const images: Array<Schema.Schema.Type<typeof CommandCodeContent>> = []
  for (const message of request.messages) {
    if (message.role !== "tool" && images.length > 0) messages.push({ role: "user", content: images.splice(0) })
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Command Code", message)
      messages.push({ role: "user", content: [{ type: "text", text: part.text }] })
      continue
    }
    if (message.role === "user") {
      const lowered = yield* lowerUserMessage(message)
      if (lowered) messages.push(lowered)
      continue
    }
    if (message.role === "assistant") {
      const lowered = yield* lowerAssistantMessage(message)
      if (lowered) messages.push(lowered)
      continue
    }
    const lowered = yield* lowerToolMessage(message)
    if (lowered.message) messages.push(lowered.message)
    images.push(...lowered.images)
  }
  if (images.length > 0) messages.push({ role: "user", content: images })
  return messages
})

const lowerSystem = (request: LLMRequest): Array<Schema.Schema.Type<typeof CommandCodeSystemPart>> =>
  request.system.map((part, index) => ({
    type: "text" as const,
    text: index < request.system.length - 1 ? `${part.text}\n` : part.text,
    ...(part.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }))

const lowerConfig = (request: LLMRequest) => {
  const options = commandCodeOptions(request)
  const workingDir = typeof options.workingDir === "string" ? options.workingDir : process.cwd()
  return {
    workingDir,
    date: new Date().toISOString().split("T")[0] ?? "",
    environment: process.platform,
    structure: [] as string[],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [] as string[],
  }
}

const fromRequest = Effect.fn("CommandCode.fromRequest")(function* (request: LLMRequest) {
  const options = commandCodeOptions(request)
  const reasoning = options.reasoningEffort
  const threadId = options.threadId
  const mode = options.mode
  return {
    config: lowerConfig(request),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: typeof options.permissionMode === "string" ? options.permissionMode : "standard",
    ...(typeof threadId === "string" ? { threadId } : {}),
    ...(typeof mode === "string" ? { mode } : {}),
    ...(options.promptCache !== undefined ? { promptCache: options.promptCache } : {}),
    params: {
      model: request.model.id,
      messages: yield* lowerMessages(request),
      tools: request.tools.length === 0 ? undefined : request.tools.map((tool) => lowerTool(tool)),
      system: lowerSystem(request),
      max_tokens: Math.min(
        request.generation?.maxTokens ?? DEFAULT_MAX_TOKENS,
        request.model.route.defaults.limits?.output ?? DEFAULT_MAX_TOKENS,
        DEFAULT_MAX_TOKENS,
      ),
      stream: true as const,
      ...(request.generation?.temperature !== undefined ? { temperature: request.generation.temperature } : {}),
      ...(typeof reasoning === "string" ? { reasoning_effort: reasoning } : {}),
    },
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
const mapFinishReason = (reason: string | undefined): FinishReason => {
  const normalized = (reason ?? "").toLowerCase()
  if (normalized === "tool_use" || normalized === "tool-calls" || normalized === "tool_calls") return "tool-calls"
  if (normalized === "length" || normalized === "max_tokens") return "length"
  if (normalized === "error") return "error"
  return "stop"
}

const mapUsage = (usage: CommandCodeEvent["totalUsage"]): Usage | undefined => {
  if (!usage) return undefined
  const details = usage.inputTokenDetails
  const cacheRead = details?.cacheReadTokens ?? usage.cachedInputTokens
  const cacheWrite = details?.cacheWriteTokens
  const nonCached =
    details?.noCacheTokens ?? ProviderShared.subtractTokens(usage.inputTokens, (cacheRead ?? 0) + (cacheWrite ?? 0))
  return new Usage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
    totalTokens: ProviderShared.totalTokens(usage.inputTokens, usage.outputTokens, usage.totalTokens),
    providerMetadata: { commandcode: usage },
  })
}

const parseToolInput = (raw: unknown) => {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return {}
    }
  }
  if (raw === undefined || raw === null) return {}
  return raw
}

const streamError = (event: CommandCodeEvent) => {
  if (typeof event.error === "string" && event.error.length > 0) return event.error
  if (ProviderShared.isRecord(event.error) && typeof event.error.message === "string")
    return `${typeof event.error.type === "string" ? `${event.error.type}: ` : ""}${event.error.message}`
  if (typeof event.message === "string" && event.message.length > 0) return event.message
  return "Command Code stream error"
}

const step = (state: ParserState, event: CommandCodeEvent) =>
  Effect.gen(function* () {
    const events: LLMEvent[] = []
    let lifecycle = state.lifecycle

    if (event.type === "error" && isContextOverflow(streamError(event)))
      return yield* new LLMError({
        module: "Command Code",
        method: "stream",
        reason: new InvalidRequestReason({ message: streamError(event), classification: "context-overflow" }),
      })
    if (event.type === "error")
      return yield* ProviderShared.eventError("Command Code", streamError(event), JSON.stringify(event))

    if (event.type === "reasoning-start")
      return [
        { ...state, lifecycle: Lifecycle.reasoningStart(lifecycle, events, event.id ?? "reasoning-0") },
        events,
      ] as const

    if (event.type === "reasoning-delta") {
      if (event.text) lifecycle = Lifecycle.reasoningDelta(lifecycle, events, event.id ?? "reasoning-0", event.text)
      return [{ ...state, lifecycle }, events] as const
    }

    if (event.type === "reasoning-end")
      return [
        { ...state, lifecycle: Lifecycle.reasoningEnd(lifecycle, events, event.id ?? "reasoning-0") },
        events,
      ] as const

    if (event.type === "text-delta") {
      if (event.text) lifecycle = Lifecycle.textDelta(lifecycle, events, event.id ?? "text-0", event.text)
      return [{ ...state, lifecycle }, events] as const
    }

    if (event.type === "text-end")
      return [{ ...state, lifecycle: Lifecycle.textEnd(lifecycle, events, event.id ?? "text-0") }, events] as const

    if (event.type === "tool-call") {
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(
        LLMEvent.toolCall({
          id: event.toolCallId ?? event.toolName ?? "tool-call",
          name: event.toolName ?? "",
          input: parseToolInput(event.input),
          ...(event.providerExecuted ? { providerExecuted: true } : {}),
        }),
      )
      return [{ ...state, lifecycle }, events] as const
    }

    if (event.type === "tool-result") {
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(
        LLMEvent.toolResult({
          id: event.toolCallId ?? event.toolName ?? "tool-result",
          name: event.toolName ?? "",
          result: { type: "json", value: event.output },
          providerExecuted: true,
        }),
      )
      return [{ ...state, lifecycle }, events] as const
    }

    if (event.type === "finish-step") {
      return [
        {
          ...state,
          usage: mapUsage(event.usage) ?? state.usage,
          finishReason: mapFinishReason(event.finishReason ?? event.rawFinishReason),
        },
        events,
      ] as const
    }

    if (event.type === "finish") {
      const usage = mapUsage(event.totalUsage) ?? state.usage
      const reason = mapFinishReason(event.finishReason ?? event.rawFinishReason ?? state.finishReason)
      Lifecycle.finish(lifecycle, events, { reason, usage })
      return [{ ...state, lifecycle, usage, finishReason: reason, finished: true }, events] as const
    }

    return [state, events] as const
  })

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (state.finished || state.finishReason === undefined) return []
  const events: LLMEvent[] = []
  Lifecycle.finish(state.lifecycle, events, { reason: state.finishReason, usage: state.usage })
  return events
}

// =============================================================================
// Protocol And Route
// =============================================================================
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: CommandCodeBody,
    from: fromRequest,
  },
  media: IMAGE_MIMES,
  stream: {
    event: Protocol.jsonEvent(CommandCodeEvent),
    initial: (): ParserState => ({ lifecycle: Lifecycle.initial(), finished: false }),
    step,
    onHalt: finishEvents,
  },
})

export const httpTransport = HttpTransport.ndjsonJson.with<CommandCodeBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "commandcode",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as CommandCode from "./commandcode"
