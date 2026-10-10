export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@miao/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
// Recovery must not send another near-window request to an endpoint that already
// rejected the catalog's window estimate. Summarize the whole head in bounded
// stages; publish a checkpoint only after every stage succeeds.
const SUMMARY_INPUT_TOKENS = 64_000
const MAX_SUMMARY_STAGES = 64
// Bound tokenizer work as well as provider input. Tokenizing a giant unbroken
// output in one pass can be pathological; independent short segments provide a
// conservative count without making recovery itself stall.
const recoveryTokens = (text: string) => {
  let total = 0
  for (let offset = 0; offset < text.length; offset += 4_096) total += Token.count(text.slice(offset, offset + 4_096))
  return total
}
/**
 * Fraction of the context window at which proactive compaction runs. Compacting
 * only once the window is full leaves no room for the summary and no margin for
 * the estimate being low; a fraction below 1 reserves both. Mirrors Codex's 90%
 * default (Claude Code lands around 83–97% depending on the window size).
 */
const DEFAULT_THRESHOLD = 0.9
/**
 * Consecutive proactive-compaction failures before one Session stops trying.
 * Without a breaker a summary the provider keeps refusing would spend a turn's
 * worth of latency on every step; a manual compaction resets the counter.
 */
const MAX_COMPACTION_FAILURES = 3
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly hotPrefix: boolean
  readonly preciseTokens: boolean
  readonly summarizeSmall: boolean
  readonly buffer: number
  readonly threshold: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  /** Cheap model for summarization; falls back to the session model when absent or too small. */
  readonly summarizeModel?: Model
  readonly request: LLMRequest
  /**
   * Prompt tokens the provider reported for the previous turn of this Session,
   * when it reported any. The provider's own count is the only signal that
   * tracks the real window: a local estimate under-counts code and CJK text, so
   * a Session driven by the estimate alone can reach the provider's true limit
   * without ever crossing the threshold.
   */
  readonly observedTokens?: number
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

/**
 * Keep a configured threshold inside `(0, 1]`. A stray `0` would compact every
 * turn and a value above `1` would never compact, so an invalid override falls
 * back to the default rather than changing behavior silently.
 */
const normalizeThreshold = (value: number) => (value > 0 && value <= 1 ? value : DEFAULT_THRESHOLD)

// Use the cheap model only when the summary request still fits its context;
// otherwise the session model is the safe choice.
export const pickSummarizeModel = (input: { model: Model; summarizeModel?: Model }, tokens: number, output: number) => {
  const candidate = input.summarizeModel
  if (!candidate) return input.model
  const context = candidate.route.defaults.limits?.context
  if (context === undefined || context <= 0) return input.model
  return tokens <= context - output ? candidate : input.model
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      hotPrefix: current.hot_prefix ?? result.hotPrefix,
      preciseTokens: current.precise_tokens ?? result.preciseTokens,
      summarizeSmall: current.summarize_small ?? result.summarizeSmall,
      buffer: current.buffer ?? result.buffer,
      threshold: normalizeThreshold(current.threshold ?? result.threshold),
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    {
      auto: true,
      hotPrefix: false,
      preciseTokens: false,
      summarizeSmall: false,
      buffer: DEFAULT_BUFFER,
      threshold: DEFAULT_THRESHOLD,
      tokens: DEFAULT_KEEP_TOKENS,
    },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

/**
 * The most recent goal the Session recorded, as the text to pin into the
 * retained context. A goal is a durable directive, and a summary is free to drop
 * it; keeping it verbatim is the difference between the agent still knowing what
 * it is working toward and re-deriving it.
 */
const pinnedGoal = (entries: readonly Entry[]): string | undefined => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message
    if (message.type === "synthetic" && message.metadata?.goal !== undefined) return message.text
  }
  return undefined
}

/** Retained recent context with the latest goal pinned, so compaction cannot drop it. */
const retained = (entries: readonly Entry[], recent: string): string => {
  const goal = pinnedGoal(entries)
  if (goal === undefined || recent.includes(goal)) return recent
  return recent.length === 0 ? goal : `${goal}\n\n${recent}`
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

export const buildHotPrompt = () =>
  [
    "Summarize the conversation above so another coding agent can continue the work. The messages above, including any earlier conversation checkpoint, are the source.",
    SUMMARY_TEMPLATE,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  // Precise BPE counting is opt-in: it changes threshold behavior, so the
  // character heuristic stays the default.
  const measure = (text: string) => (config.preciseTokens ? Token.count(text) : Token.estimate(text))
  const measureValue = (value: unknown) => Token.measureValue(value, measure)
  // Consecutive proactive-compaction failures per Session. A provider that keeps
  // refusing the summary must not cost a summary attempt on every drain; the
  // breaker trips until a compaction succeeds or a manual one resets it.
  const failures = new Map<string, number>()
  // One summarization attempt. Returns the text only when the stream completed
  // cleanly and produced a non-empty summary, so an empty or refused response
  // can never replace the conversation.
  const summarizeOnce = (request: LLMRequest) =>
    Effect.gen(function* () {
      const chunks: string[] = []
      let failed = false
      const completed = yield* dependencies.llm.stream(request).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
      const summary = chunks.join("")
      return completed && !failed && summary.trim() ? summary : undefined
    })

  const runSummary = Effect.fnUntraced(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly request: LLMRequest
    /** Retried when the primary summarize request is refused or fails. */
    readonly fallbackRequest?: LLMRequest
    readonly recent: string
    readonly summary?: Effect.Effect<string | undefined>
  }) {
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    // A refused or failed cheap-model summary falls back to the session model
    // once before giving up, matching the "refusal -> retry with another model"
    // behavior for compaction (research G3).
    let summary = input.summary ? yield* input.summary : yield* summarizeOnce(input.request)
    if (summary === undefined && !input.summary && input.fallbackRequest)
      summary = yield* summarizeOnce(input.fallbackRequest)
    if (summary === undefined) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: input.recent,
    })
    return true
  })

  // Proactive compaction reuses the current request prefix (system, tools, and
  // conversation), so the provider serves it from the warm prompt cache, and
  // appends the summary instruction as the final user message.
  const compactHot = Effect.fn("SessionCompaction.compactHot")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const instruction = buildHotPrompt()
    const requestTokens = measureValue({
      system: input.request.system,
      messages: input.request.messages,
      tools: input.request.tools,
    })
    if (requestTokens + measure(instruction) > context - summaryOutput) return false
    const summarizeModel = config.summarizeSmall
      ? pickSummarizeModel(input, requestTokens + measure(instruction), summaryOutput)
      : input.model
    const selected = select(input.entries, config.tokens)
    const requestFor = (model: Model) =>
      LLM.request({
        model,
        http: input.request.http,
        providerOptions: input.request.providerOptions,
        system: input.request.system,
        messages: [...input.request.messages, Message.user(instruction)],
        tools: input.request.tools,
        toolChoice: "none",
        generation: { maxTokens: summaryOutput },
      })
    return yield* runSummary({
      sessionID: input.sessionID,
      recent: retained(input.entries, selected?.recent ?? ""),
      request: requestFor(summarizeModel),
      fallbackRequest: summarizeModel === input.model ? undefined : requestFor(input.model),
    })
  })

  // Overflow recovery cannot reuse the prefix (the request already failed to
  // fit), so it re-embeds a truncated head instead.
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (
    input: Input,
    options?: { readonly allowSummaryOnly?: boolean },
  ) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected) {
      // Nothing fresh to summarize. Only the bounded overflow-recovery path may
      // compact an existing summary again, and only while it still carries a
      // retained tail; otherwise a summary-only history would loop forever.
      if (!options?.allowSummaryOnly || previousSummary?.type !== "compaction" || previousSummary.recent.length === 0)
        return false
    }
    const head = selected?.head ?? ""
    if (head.length === 0 && previousSummary?.type !== "compaction") return false
    const source = [previousSummary?.type === "compaction" ? previousSummary.recent : "", head]
      .filter(Boolean)
      .join("\n\n")
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [source],
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const systemTokens = Token.measureValue(input.request.system, recoveryTokens)
    const ceiling = Math.min(SUMMARY_INPUT_TOKENS, context)
    const requestFor = (model: Model, prompt: string) =>
      LLM.request({
        model,
        http: input.request.http,
        providerOptions: input.request.providerOptions,
        system: input.request.system,
        messages: [Message.user(prompt)],
        tools: [],
        generation: { maxTokens: summaryOutput },
      })
    const choose = (prompt: string) =>
      config.summarizeSmall
        ? pickSummarizeModel(input, systemTokens + recoveryTokens(prompt), summaryOutput)
        : input.model
    const summarizeModel = choose(summaryPrompt)
    const staged = Effect.gen(function* () {
      let summary = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
      let offset = 0
      for (let stage = 0; stage < MAX_SUMMARY_STAGES; stage++) {
        const overhead = systemTokens + recoveryTokens(buildPrompt({ previousSummary: summary, context: [""] }))
        const budget = ceiling - summaryOutput - overhead
        if (budget <= 0) return undefined
        let end = Math.min(source.length, offset + budget * 2)
        while (end > offset && recoveryTokens(source.slice(offset, end)) > budget)
          end = offset + Math.floor((end - offset) / 2)
        const last = source.charCodeAt(end - 1)
        if (last >= 0xd800 && last <= 0xdbff) end--
        if (end <= offset) return undefined
        const prompt = buildPrompt({ previousSummary: summary, context: [source.slice(offset, end)] })
        const model = choose(prompt)
        let next = yield* summarizeOnce(requestFor(model, prompt))
        if (next === undefined && model !== input.model) next = yield* summarizeOnce(requestFor(input.model, prompt))
        if (next === undefined) return undefined
        summary = next
        offset = end
        if (offset === source.length) return summary
      }
      return undefined
    })
    return yield* runSummary({
      sessionID: input.sessionID,
      recent: retained(input.entries, selected?.recent ?? ""),
      request: requestFor(summarizeModel, summaryPrompt),
      fallbackRequest: summarizeModel === input.model ? undefined : requestFor(input.model, summaryPrompt),
      ...(systemTokens + recoveryTokens(summaryPrompt) + summaryOutput > ceiling ? { summary: staged } : {}),
    })
  })

  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    // Reserve what this turn can still generate, not the model's declared output
    // ceiling: `limits.output` is a catalog limit, and treating it as the reserve
    // shrinks the usable window to a fraction of the real context.
    const reserve = Math.max(input.request.generation?.maxTokens ?? 0, config.buffer)
    // The provider's reported prompt tokens are ground truth for the history the
    // last turn sent; the local estimate covers the growth since then (and is the
    // only signal before the first usage). Take the larger: the estimate alone
    // under-counts code and CJK text, and the reported count alone lags a turn
    // that just added a large tool result.
    const size = Math.max(
      input.observedTokens ?? 0,
      measureValue({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }),
    )
    // Trigger below the raw limit, not at it: the summary request needs room too.
    if (size <= context * config.threshold - reserve) return false
    const key = input.sessionID
    if ((failures.get(key) ?? 0) >= MAX_COMPACTION_FAILURES) return false
    const compacted = yield* config.hotPrefix ? compactHot(input) : compactAfterOverflow(input)
    if (compacted) failures.delete(key)
    else failures.set(key, (failures.get(key) ?? 0) + 1)
    return compacted
  })

  const reset = (sessionID: Input["sessionID"]) => {
    failures.delete(sessionID)
    return Effect.void
  }

  return {
    compactIfNeeded,
    compactAfterOverflow,
    reset,
  }
}
