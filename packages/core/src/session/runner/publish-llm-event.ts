import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@miao/llm"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionRunnerCost } from "./cost"
import type { Tool } from "../../tool/tool"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly cost?: ModelV2.Info["cost"]
  readonly snapshot?: string
  /**
   * Applied to a settled tool result before it becomes durable. Every tool
   * reaches this one point, so the bound lives here rather than in each tool.
   */
  readonly normalizeContent?: (content: ToolOutput["content"]) => Effect.Effect<ToolOutput["content"]>
  /**
   * Applied to a settled tool result's raw structured output before it becomes
   * durable. Tools whose structured output carries the same bytes as their
   * model-facing content externalize them here so the durable event stays small.
   */
  readonly normalizeStructured?: (structured: Record<string, unknown>) => Effect.Effect<Record<string, unknown>>
}

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
/**
 * Durable progress is an advisory UI hint, but each event rewrites the whole
 * assistant row, so a chatty tool must not publish per chunk: the first update
 * for a call goes out immediately and later ones at most every 500ms. The
 * authoritative state arrives with tool.success regardless.
 */
export const PROGRESS_MIN_INTERVAL_MS = 500

/**
 * A file preview above this many base64 characters stays out of the durable
 * progress event entirely: progress replays nowhere, and the tool result
 * carries the real bytes externalized to the blob store.
 */
export const PROGRESS_MAX_INLINE_BASE64 = 256 * 1024

/** Durable progress content, without oversized inline file previews. */
export const progressContent = (
  parts: ReadonlyArray<Tool.Content>,
): SessionEvent.Tool.Progress["data"]["content"] => {
  const content: Array<SessionEvent.Tool.Progress["data"]["content"][number]> = []
  for (const part of parts) {
    if (part.type !== "file") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.data.length > PROGRESS_MAX_INLINE_BASE64) continue
    content.push({ type: "file", uri: `data:${part.mime};base64,${part.data}`, mime: part.mime, name: part.name })
  }
  return content
}

/** Per-call admission for durable tool progress events. */
export const progressGate = () => {
  const last = new Map<string, number>()
  return (key: string, now: number) => {
    if (now - (last.get(key) ?? 0) < PROGRESS_MIN_INTERVAL_MS) return false
    last.set(key, now)
    return true
  }
}

export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  // Call ids a provider started again after the call was already made.
  const replayed = new Set<string>()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  // Visible output is answer content (text or a tool call), as opposed to
  // reasoning. Reasoning is live-only, so a retry after a drop that streamed
  // only reasoning replays nothing the user already saw as an answer.
  let visibleOutput = false
  let stepSettlement:
    | { readonly finish: string; readonly cost: number; readonly tokens: ReturnType<typeof tokens> }
    | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    // Drops buffered fragments without publishing them. The provider stream's
    // own flush normally empties these first; this keeps a retry from ending a
    // fragment it never streamed if that flush is ever bypassed.
    const discard = () => chunks.clear()
    return { start, append, end, flush, discard }
  }

  const text = fragments("text", (textID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const existing = tools.get(event.id)
    // Some providers resend a finished call whole (start, deltas, end, call) with
    // the same id. The first copy already ran, so the echo is dropped, not fatal.
    if (existing?.called) {
      replayed.add(event.id)
      return yield* Effect.logWarning("ignoring replayed tool call", { callID: event.id, tool: event.name })
    }
    if (existing) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  // Clears any fragment the failed attempt left buffered before the retry, so
  // the retry cannot end a fragment it never streamed.
  const discardInFlight = Effect.fnUntraced(function* () {
    text.discard()
    reasoning.discard()
    toolInput.discard()
  })

  const failAssistant = Effect.fnUntraced(function* (message: string) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: { type: "unknown", message },
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  /** Fails one recorded call without executing it, marking it settled. */
  const failTool = Effect.fn("SessionRunner.failTool")(function* (callID: string, message: string) {
    const tool = tools.get(callID)
    if (!tool || tool.settled) return
    tool.settled = true
    yield* events.publish(SessionEvent.Tool.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID: tool.assistantMessageID,
      callID,
      error: { type: "unknown", message },
      provider: {
        executed: tool.providerExecuted,
        ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
      },
    })
  })

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        return
      case "text-start":
        visibleOutput = true
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        visibleOutput = true
        yield* text.append(event.id, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID: event.id,
          delta: event.text,
        })
        return
      case "text-end":
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          delta: event.text,
        })
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        visibleOutput = true
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        if (replayed.has(event.id)) return
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        if (replayed.has(event.id)) return
        yield* endToolInput(event)
        return
      case "tool-call": {
        visibleOutput = true
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called)
          return yield* Effect.logWarning("ignoring replayed tool call", { callID: event.id, tool: event.name })
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          return
        }
        // A provider-executed result is replayed verbatim from the provider's
        // own transcript, so its content must stay exactly as delivered.
        const content =
          provider.executed || input.normalizeContent === undefined
            ? result.content
            : yield* input.normalizeContent(result.content)
        const structured =
          provider.executed || input.normalizeStructured === undefined
            ? result.structured
            : yield* input.normalizeStructured(result.structured)
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          structured,
          content,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish":
        yield* flush()
        assistantActive = false
        if (stepSettlement) return yield* Effect.die("Duplicate step finish")
        stepSettlement = {
          finish: event.reason,
          cost: SessionRunnerCost.of(input.cost ?? [], event.usage),
          tokens: tokens(event.usage),
        }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant(event.message)
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    failTool,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasVisibleOutput: () => visibleOutput,
    discardInFlight,
    hasToolCalls: () => tools.size > 0,
    toolCalled: (callID: string) => tools.get(callID)?.called === true,
    hasProviderError: () => providerFailed,
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
