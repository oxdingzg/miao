import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolFailure,
  isContextOverflowFailure,
  type LLMRequest,
  type Model,
  type ProviderErrorEvent,
  type ToolOutput,
} from "@miao/llm"
import { Cause, DateTime, Duration, Effect, FiberSet, Layer, Option, Semaphore, Stream, Schema } from "effect"
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { Image } from "../../image"
import { SystemContext } from "../../system-context/index"
import { Persona } from "../../system-context/persona"
import { SystemContextRegistry } from "../../system-context/registry"
import { Flag } from "../../flag/flag"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { BashTool } from "../../tool/bash"
import { LocationMutation } from "../../location-mutation"
import { SessionCommandPrepare } from "../command-prepare"
import { TaskTool } from "../../tool/task"
import { GoalTool } from "../../tool/goal"
import { BackgroundJob } from "../../background-job"
import { BackgroundJobTool } from "../../tool/background-job"
import { SendMessageTool } from "../../tool/send-message"
import { ListSessionsTool } from "../../tool/list-sessions"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionCreate } from "../../session-create"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionCompactRequest } from "../compact-request"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionMessage } from "../message"
import { SessionPrune } from "../prune"
import { SessionInput } from "../input"
import { ToolCallLeak } from "../tool-call-leak"
import { Prompt } from "../prompt"
import { SessionSchema } from "../schema"
import { SessionTable, SessionMessageTable } from "../sql"
import { SessionStore } from "../store"
import { SessionImageNormalize } from "../image-normalize"
import { SessionBlobStorage } from "../blob-storage"
import { SessionTodo } from "../todo"
import { SessionTitle } from "../title"
import { LegacyNotMigratedError } from "../error"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { SessionRunnerProviderHeaders } from "./provider-headers"
import { SessionRunnerProviderRetry } from "./provider-retry"
import { SessionOutputGuard } from "./output-guard"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { inlineTextFiles, materializeBlobRefs } from "./materialize-files"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { SessionRunnerMetrics } from "./metrics"
import { Snapshot } from "../../snapshot"
import { Blob } from "../../blob"
import { FSUtil } from "../../fs-util"
import { Integration } from "../../integration"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [x] Bound provider retries (`runner/provider-retry`) and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@miao/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [x] Normalize image attachments against the model's declared input capabilities.
 *   - [ ] Add scoped runtime context, progress updates, plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * In-turn provider retries are bounded by `runner/provider-retry`. Durable continuation recovery
 * across drains remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

/** Cap on how many times one identical (name, input) tool call may execute in a drain. */
const MAX_IDENTICAL_TOOL_CALLS = 5

/**
 * How many overflow compactions one drain may attempt before surfacing the
 * failure. A turn can still overflow after a compaction, so compact again on
 * the smaller history before giving up (research G3).
 */
const MAX_OVERFLOW_COMPACTIONS = 2

/**
 * How long a subagent may go without emitting any event before its drain is
 * treated as stuck. Silence means no provider delta, no tool call, and no tool
 * result, so the longest legitimate gap is a tool running to its own ceiling;
 * Bash caps one command at ten minutes.
 */
const SUBAGENT_SILENCE_MINUTES = 15
const SUBAGENT_SILENCE = Duration.minutes(SUBAGENT_SILENCE_MINUTES)

/**
 * How long the provider may go between streamed events before the gap is worth
 * recording. A turn that is still running has no `session.turn` line yet, so a
 * stalled stream is otherwise invisible until it settles. Only the gap is
 * logged, not every chunk, so the volume stays proportional to the number of
 * stalls rather than the number of tokens; per-chunk recording stays opt-in
 * through the provider wire archive.
 */
const STREAM_STALL_MS = 5_000

/** Goal/todo-driven autonomous loop bounds. */
const DEFAULT_LOOP_MAX_ITERATIONS = 25
const LOOP_STALL_LIMIT = 2
const DEFAULT_LOOP_PROMPT =
  "Continue with the next incomplete todo item. Make concrete progress, then update the todo list. If every todo is complete and verified, reply DONE and stop."

const signatureInput = (input: unknown) => {
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const shell = yield* BashTool.Execution
    const mutation = yield* LocationMutation.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const creation = yield* SessionCreate.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service
    const blob = yield* Blob.Service
    const fs = yield* FSUtil.Service
    const image = yield* Image.Service
    const normalizeToolContent = (content: ToolOutput["content"]) =>
      SessionImageNormalize.toolContent(image, content).pipe(
        Effect.flatMap((normalized) => SessionBlobStorage.externalizeToolContent(blob, normalized)),
      )
    const db = (yield* Database.Service).db
    // Per-session prompt-cache telemetry: when the last provider turn ran and
    // whether the next one is expected to rebuild the prefix (right after a
    // compaction). Process-local and best-effort.
    const WARM_WINDOW_MS = 5 * 60_000
    const turns = new Map<string, { at: number; afterCompaction: boolean }>()
    // Repeated identical tool calls per Session drain; reset at each drain start.
    const repeatedToolCalls = new Map<string, number>()
    const readSettings = Effect.fnUntraced(function* () {
      const documents = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
      let ttl: number | undefined
      let prune = false
      let budget: number | undefined
      let loop: { readonly maxIterations: number; readonly continuePrompt: string } | undefined
      let disabledTools: ReadonlyArray<string> = []
      for (const entry of documents) {
        if (entry.info.cache?.ttl_seconds !== undefined) ttl = entry.info.cache.ttl_seconds
        if (entry.info.compaction?.prune !== undefined) prune = entry.info.compaction.prune
        if (entry.info.cost?.budget_usd !== undefined) budget = entry.info.cost.budget_usd
        if (entry.info.disabled_tools !== undefined) disabledTools = entry.info.disabled_tools
        if (entry.info.loop?.enabled === true)
          loop = {
            maxIterations: entry.info.loop.max_iterations ?? DEFAULT_LOOP_MAX_ITERATIONS,
            continuePrompt: entry.info.loop.continue_prompt ?? DEFAULT_LOOP_PROMPT,
          }
      }
      return { ttl, prune, budget, loop, disabledTools }
    })
    // Title generation runs beside the first provider turn and outlives the drain.
    // One attempt per Session per process, like V1's single first-step attempt.
    const titleFibers = yield* FiberSet.make<void>()
    const titled = new Set<string>()
    const generateTitle = Effect.fn("SessionRunner.generateTitle")(
      function* (input: {
        readonly session: SessionSchema.Info
        readonly prompt: string
        readonly model: Model
        readonly small: Model | undefined
        readonly http: LLMRequest["http"]
      }) {
        const agent = yield* agents.get(AgentV2.ID.make("title"))
        if (!agent) return
        const model = agent.model
          ? (yield* models.resolve({ ...input.session, model: agent.model })).model
          : (input.small ?? input.model)
        const title = yield* SessionTitle.generate({
          llm,
          model,
          http: input.http,
          system: agent.system,
          prompt: input.prompt,
        })
        if (!title) return
        // The user may have renamed the Session while the title model ran.
        const current = yield* store.get(input.session.id)
        if (!current || !SessionTitle.isDefault(current.title)) return
        yield* events.publish(SessionEvent.Info.Updated, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          title,
        })
      },
      Effect.catch((error) => Effect.logWarning("failed to generate title", { error })),
      Effect.catchDefect((defect) => Effect.logWarning("failed to generate title", { defect })),
    )
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          // `pending` means the runner never dispatched the call (there is no
          // `session.next.tool.called`), so no side effect happened and the model
          // may retry it. `running` means it was dispatched; the side effect may
          // or may not have happened, so the outcome is unknown.
          const dispatched = tool.state.status === "running"
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: {
              type: "unknown",
              message: dispatched
                ? "Tool execution outcome unknown: the process stopped while it was running."
                : "Tool was not executed: the process stopped before it was dispatched, so it is safe to retry.",
            },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    /**
     * Detect a turn that ended because the model wrote its tool call as plain
     * text instead of emitting a structured call. Returns the leaked assistant
     * message and how many nudges this user prompt already spent, or undefined
     * when the turn is fine. Only a `stop` turn with no recorded tool call is a
     * candidate: a normal completion, or a turn that already ran tools, is not.
     */
    const leakedToolCall = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const context = yield* getContext(sessionID)
      const assistant = context.findLast((message) => message.type === "assistant")
      if (!assistant) return undefined
      if (!ToolCallLeak.isLeakedAssistant(assistant)) return undefined
      return { messageID: assistant.id, attempts: ToolCallLeak.countAttempts(context) }
    })

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }
      // Forced (user-requested) compaction completed; end the drain without a provider turn.
      | { readonly _tag: "StopAfterCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })
    const stopAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "StopAfterCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map((contexts) => SystemContext.combine([...contexts, SessionTodo.context(todos, sessionID)])))

    const prepareCommands = Effect.fn("SessionRunner.prepareCommands")(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db.select().from(SessionMessageTable).where(and(
        eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"),
        sql`json_extract(${SessionMessageTable.data}, '$.command') IS NOT NULL`,
        sql`(json_extract(${SessionMessageTable.data}, '$.commandState') IS NULL OR json_extract(${SessionMessageTable.data}, '$.commandState') = 'running')`,
      )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
      for (const row of rows) {
        const user = yield* Schema.decodeUnknownEffect(SessionMessage.User)({ ...row.data, id: row.id, type: "user" }).pipe(Effect.orDie)
        const failed = (error: string) => events.publish(SessionEvent.Command.Failed, { sessionID, messageID: user.id, timestamp: DateTime.makeUnsafe(Date.now()), error, text: `Slash command failed: ${error}\nDo not retry its side effects automatically; reconcile with the user before retrying.` })
        if (user.commandState === "running") {
          yield* failed("Command preparation was interrupted or its outcome is unknown. It was not replayed.")
          continue
        }
        yield* events.publish(SessionEvent.Command.Started, { sessionID, messageID: user.id, timestamp: yield* DateTime.now })
        yield* Effect.gen(function* () {
          const session = yield* getSession(sessionID)
          if (user.command?.subtask && session.parentID) return yield* new ToolFailure({ message: "Nested command subtasks are not supported." })
          if (user.command?.subtask) yield* permission.assert({
            action: "task", resources: [user.command.agent ?? session.agent ?? "build"], save: ["*"], sessionID, agent: session.agent,
            source: { type: "command", messageID: user.id, name: user.command.name, callID: `${user.id}/subtask` },
          })
          const prompt = yield* SessionCommandPrepare.prepare(user, session, { agents, fs, mutation, permission, shell, events })
          if (user.command?.subtask) {
            const result = yield* runSubagent(sessionID, {
              agent: user.command.agent ?? session.agent ?? "build", prompt: prompt.text, description: user.command.name,
              model: user.command.model, files: prompt.files, agents: prompt.agents,
            })
            yield* events.publish(SessionEvent.Command.Completed, { sessionID, messageID: user.id, timestamp: yield* DateTime.now,
              prompt: Prompt.make({ text: `Command /${user.command.name} completed in child Session ${result.sessionID}:\n${result.text}` }),
            })
            return
          }
          if (user.command?.agent) yield* events.publish(SessionEvent.AgentSwitched, { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, agent: user.command.agent })
          if (user.command?.model) yield* events.publish(SessionEvent.ModelSwitched, { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, model: user.command.model })
          yield* events.publish(SessionEvent.Command.Completed, { sessionID, messageID: user.id, timestamp: yield* DateTime.now, prompt: yield* SessionBlobStorage.externalizePromptAttachments(blob, prompt) })
        }).pipe(
          Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: String(error) })),
          Effect.catchTag("LLM.ToolFailure", (error) => failed(error.message)),
          Effect.onInterrupt(() => failed("Command preparation was interrupted; its side effects were not replayed.")),
        )
      }
      return rows.length > 0
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const attemptStartedAt = Date.now()
      const initialSession = yield* getSession(sessionID)
      if (initialSession.location.directory !== location.directory || initialSession.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const sessionMs = Date.now() - attemptStartedAt
      const agentStartedAt = Date.now()
      const initialAgent = yield* agents.select(initialSession.agent)
      const agentMs = Date.now() - agentStartedAt
      const epochStartedAt = Date.now()
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(initialAgent, initialSession.id), initialSession.id)
      const epochMs = Date.now() - epochStartedAt
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, initialSession.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, initialSession.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, initialSession.id))
          promoted += yield* SessionInput.promoteSteers(db, events, initialSession.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const commandChanged = yield* prepareCommands(sessionID)
      const session = commandChanged ? yield* getSession(sessionID) : initialSession
      const agent = commandChanged ? yield* agents.select(session.agent) : initialAgent
      const system =
        (commandChanged ? undefined : initialized) ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id))
      const resolveStartedAt = Date.now()
      const catalogRetry = { attempt: 0, error: undefined as SessionRunnerModel.Error | undefined }
      const resolved = yield* Effect.suspend(() => {
        const previous = catalogRetry.error
        catalogRetry.error = undefined
        return (
          previous
            ? events.publish(SessionEvent.Retried, {
                sessionID: session.id,
                timestamp: DateTime.makeUnsafe(Date.now()),
                attempt: ++catalogRetry.attempt,
                error: retryDetail(previous),
              })
            : Effect.void
        ).pipe(Effect.andThen(models.resolve(session)))
      }).pipe(
        // A provider can be missing from the catalog for a few seconds while a
        // credential refresh or plugin boot settles; waiting for it beats
        // failing the turn.
        Effect.tapError((error) =>
          SessionRunnerProviderRetry.retryable(error)
            ? Effect.sync(() => {
                catalogRetry.error = error
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("retrying unavailable model", { sessionID: session.id, tag: error._tag }),
                ),
              )
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => SessionRunnerProviderRetry.retryable(error),
          schedule: SessionRunnerProviderRetry.catalogSchedule,
        }),
        Effect.tapError((error) =>
          createLLMEventPublisher(events, {
            sessionID: session.id,
            agent: agent.id,
            model: session.model ?? {
              id: ModelV2.ID.make("unavailable"),
              providerID: ProviderV2.ID.make("unavailable"),
            },
          }).failAssistant(error.message),
        ),
      )
      const resolveMs = Date.now() - resolveStartedAt
      const model = resolved.model
      const smallStartedAt = Date.now()
      const summarizeModel = yield* models.resolveSmall(session)
      const smallMs = Date.now() - smallStartedAt
      const historyStartedAt = Date.now()
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const historyMs = Date.now() - historyStartedAt
      const context = entries.map((entry) => entry.message)
      // A leaked tool call the model wrote as text stays in the durable row (the
      // user can still see it), but it must not reach the provider verbatim: the
      // model imitates its own prior output, so each later turn reseeds the same
      // malformed block. Neutralize the body in the provider-facing copy only.
      const providerContext = context.map((message) => {
        if (message.type !== "assistant") return message
        const repetitive =
          message.error?.message.startsWith(SessionOutputGuard.ERROR_PREFIX) ||
          message.content.some(
            (item) => (item.type === "text" || item.type === "reasoning") && SessionOutputGuard.detect(item.text),
          )
        if (repetitive)
          return {
            ...message,
            content: message.content.map((item) => {
              if (item.type === "text") return { ...item, text: SessionOutputGuard.NEUTRALIZED }
              if (item.type === "reasoning")
                return { ...item, text: SessionOutputGuard.NEUTRALIZED, providerMetadata: undefined }
              return item
            }),
          }
        if (!ToolCallLeak.isLeakedAssistant(message)) return message
        return {
          ...message,
          content: message.content.map((item) =>
            item.type === "text" ? { ...item, text: ToolCallLeak.NEUTRALIZED } : item,
          ),
        }
      })
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const settings = yield* readSettings()
      const toolsStartedAt = Date.now()
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(agent.info?.permissions, {
            codeMode: Flag.MIAO_EXPERIMENTAL_CODE_MODE,
            sessionID: session.id,
            disabledTools: settings.disabledTools,
            onProgress: (input, update) =>
              events
                .publish(SessionEvent.Tool.Progress, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  assistantMessageID: input.assistantMessageID,
                  callID: input.call.id,
                  structured: update.structured ?? {},
                  content: (update.content ?? []).map((part) =>
                    part.type === "text"
                      ? { type: "text" as const, text: part.text }
                      : {
                          type: "file" as const,
                          uri: `data:${part.mime};base64,${part.data}`,
                          mime: part.mime,
                          name: part.name,
                        },
                  ),
                })
                .pipe(Effect.asVoid),
          })
      const toolsMs = Date.now() - toolsStartedAt
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const prior = turns.get(session.id)
      const expectedRebuild = prior?.afterCompaction === true
      const warm = prior !== undefined && Date.now() - prior.at < WARM_WINDOW_MS
      turns.set(session.id, { at: Date.now(), afterCompaction: false })
      const requestBuildStartedAt = Date.now()
      const materialized = yield* materializeBlobRefs(blob, providerContext).pipe(
        Effect.flatMap((messages) => inlineTextFiles(fs, messages)),
      )
      const messages = [
        ...toLLMMessages(materialized, model, resolved.info.capabilities.input),
        ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
      ]
      const request = LLM.request({
        model,
        http: {
          headers: SessionRunnerProviderHeaders.forTurn({
            providerID: model.provider,
            sessionID: session.id,
            parentID: session.parentID,
            promptCacheKey,
            messages,
          }),
        },
        providerOptions: { openai: { promptCacheKey } },
        cache: settings.ttl
          ? { tools: true, system: true, messages: "latest-user-message", ttlSeconds: settings.ttl }
          : undefined,
        system: [
          // An agent that declares its own system prompt replaces the model
          // family persona rather than stacking with it, so a subagent keeps
          // its focused role text and only a role-free agent inherits the
          // family's tool-calling etiquette. The persona is a pure function of
          // the resolved model, so it stays out of the durable context epoch:
          // rebuilding the prefix per turn is what lets the user switch models
          // mid-session without injecting a second persona into the history.
          agent.info?.system ??
            Persona.system({
              providerID: resolved.info.providerID,
              modelID: resolved.info.id,
              apiID: resolved.info.api.id,
            }),
          system.baseline,
        ]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: settings.prune ? SessionPrune.toolResults(messages) : messages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      const requestBuildMs = Date.now() - requestBuildStartedAt
      // Like V1: title a root Session that still has its placeholder title once
      // its first real user prompt reaches the model.
      const users = context.filter((message) => message.type === "user")
      if (!session.parentID && users.length === 1 && SessionTitle.isDefault(session.title) && !titled.has(session.id)) {
        titled.add(session.id)
        yield* FiberSet.run(
          titleFibers,
          generateTitle({ session, prompt: users[0].text, model, small: summarizeModel, http: request.http }),
        )
      }
      const compactStartedAt = Date.now()
      if (SessionCompactRequest.consume(session.id)) {
        const compacted = yield* compaction.compactAfterOverflow({
          sessionID: session.id,
          entries,
          model,
          summarizeModel,
          request,
        })
        if (compacted) turns.set(session.id, { at: Date.now(), afterCompaction: true })
        yield* Effect.logInfo("session.compaction", {
          sessionID: session.id,
          cause: "overflow",
          ms: Date.now() - compactStartedAt,
        })
        return yield* Effect.die(stopAfterCompaction(currentStep))
      }
      const compactCheckedAt = Date.now()
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, summarizeModel, request })) {
        turns.set(session.id, { at: Date.now(), afterCompaction: true })
        yield* Effect.logInfo("session.compaction", {
          sessionID: session.id,
          cause: "threshold",
          ms: Date.now() - compactCheckedAt,
        })
        return yield* Effect.die(continueAfterCompaction(currentStep))
      }
      const compactMs = Date.now() - compactStartedAt
      const startSnapshotStartedAt = Date.now()
      const startSnapshot = yield* snapshots.capture()
      const startSnapshotMs = Date.now() - startSnapshotStartedAt
      // The step's own model identity, shared by the publisher's `Started` event
      // and the settlement below so both name the same model.
      const stepModel = {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      }
      // A provider turn that is still running has no settled `session.turn` line
      // yet, so record its start to make an in-flight turn queryable.
      yield* Effect.logInfo("session.turn.started", {
        sessionID: session.id,
        model: `${model.provider}/${model.id}`,
        step: currentStep,
      })
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: stepModel,
        cost: resolved.info.cost,
        snapshot: startSnapshot,
        normalizeContent: normalizeToolContent,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let requestStartedAt: number | undefined
      let firstEventAt: number | undefined
      let lastHandledAt: number | undefined
      const providerStream = llm.stream(request).pipe(
        SessionOutputGuard.wrap,
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const receivedAt = Date.now()
            const stallMs = lastHandledAt === undefined ? 0 : receivedAt - lastHandledAt
            if (stallMs >= STREAM_STALL_MS)
              yield* Effect.logWarning("session.stream.stall", {
                sessionID: session.id,
                model: `${model.provider}/${model.id}`,
                gapMs: stallMs,
              })
            firstEventAt ??= receivedAt
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            // A replayed call id was already executed by its first copy; the
            // publisher drops the echo and it must not run a second time.
            const replay = event.type === "tool-call" && publisher.toolCalled(event.id)
            yield* publish(event)
            if (replay || event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const signature = `${session.id}\u0000${event.name}\u0000${signatureInput(event.input)}`
            const executions = (repeatedToolCalls.get(signature) ?? 0) + 1
            repeatedToolCalls.set(signature, executions)
            if (executions > MAX_IDENTICAL_TOOL_CALLS) {
              yield* withPublication(
                publisher.failTool(
                  event.id,
                  `Refusing to run ${event.name} again: the same call has already executed ${MAX_IDENTICAL_TOOL_CALLS} times in this turn. Stop repeating it and change approach, or explain the blocker.`,
                ),
              )
              return
            }
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                lastHandledAt = Date.now()
              }),
            ),
          ),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      // The failure the next attempt retries; announced durably when that attempt starts,
      // so a retry the schedule declines is never reported.
      let retrying: LLMError | SessionRunnerModel.Error | undefined
      let attempt = 0
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* Effect.suspend(() => {
            // Reset per attempt so a retried stream neither skips events based on
            // the previous attempt's overflow capture nor reports its latency.
            overflowFailure = undefined
            firstEventAt = undefined
            lastHandledAt = undefined
            const retried = retrying
            retrying = undefined
            if (retried) attempt++
            return (
              retried
                ? events.publish(SessionEvent.Retried, {
                    sessionID: session.id,
                    timestamp: DateTime.makeUnsafe(Date.now()),
                    attempt,
                    error: retryDetail(retried),
                  })
                : Effect.void
            ).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  requestStartedAt = Date.now()
                  return restore(providerStream)
                }),
              ),
            )
          }).pipe(
            // Retry only while the attempt failed before publishing anything:
            // once text, reasoning, or a tool call is visible, replaying the
            // turn would duplicate it. Interrupts never retry.
            Effect.tapError((error) =>
              SessionRunnerProviderRetry.retryable(error)
                ? Effect.sync(() => {
                    retrying = error
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning("retrying provider attempt", {
                        sessionID: session.id,
                        model: `${model.provider}/${model.id}`,
                        tag: error._tag,
                        ...retryLog(error),
                      }),
                    ),
                  )
                : Effect.void,
            ),
            Effect.retry({
              while: (error) =>
                !publisher.hasAssistantStarted() &&
                !publisher.hasProviderError() &&
                SessionRunnerProviderRetry.retryable(error),
              schedule: SessionRunnerProviderRetry.providerSchedule,
            }),
            Effect.exit,
          )
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, summarizeModel, request })))
          ) {
            turns.set(session.id, { at: Date.now(), afterCompaction: true })
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          }
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            const detail = retryDetail(llmFailure)
            yield* withPublication(publisher.failAssistant(detail.statusCode === undefined
              ? llmFailure.reason.message
              : `API Error: ${detail.statusCode} · ${llmFailure.reason.message}`))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          // A cleanly-closed stream without a step-finish frame is incomplete, not a
          // successful turn: surface it as a failed step instead of a partial answer.
          if (stream._tag === "Success" && !publisher.hasProviderError() && publisher.hasActiveAssistant())
            yield* withPublication(publisher.failAssistant("Provider stream ended without a completion frame"))
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const cacheMissed = SessionRunnerMetrics.cacheMissed(stepSettlement.tokens)
            const endSnapshotStartedAt = Date.now()
            const endSnapshot = yield* snapshots.capture()
            const endSnapshotMs = Date.now() - endSnapshotStartedAt
            const filesStartedAt = Date.now()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const filesMs = Date.now() - filesStartedAt
            // The event carries the same figure the log line reports, so the two
            // can never disagree about how long the provider took to start.
            const ttftMs =
              requestStartedAt !== undefined && firstEventAt !== undefined ? firstEventAt - requestStartedAt : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                model: stepModel,
                finish: stepSettlement.finish,
                cost: stepSettlement.cost,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
                ttft: ttftMs,
              }),
            )
            yield* Effect.logInfo("session.turn", {
              sessionID: session.id,
              model: `${model.provider}/${model.id}`,
              ttftMs,
              turnMs: Date.now() - attemptStartedAt,
              local: {
                sessionMs,
                agentMs,
                epochMs,
                resolveMs,
                smallMs,
                historyMs,
                toolsMs,
                requestBuildMs,
                compactMs,
                startSnapshotMs,
                endSnapshotMs,
                filesMs,
                preRequestMs: requestStartedAt === undefined ? undefined : requestStartedAt - attemptStartedAt,
              },
              warm,
              expectedRebuild,
              cacheMiss: cacheMissed,
              cacheMissCause: SessionRunnerMetrics.cacheMissCause({ miss: cacheMissed, warm, expectedRebuild }),
              cacheHitRatio: SessionRunnerMetrics.cacheHitRatio(stepSettlement.tokens),
              cost: stepSettlement.cost,
              tokens: stepSettlement.tokens,
            })
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      remaining?: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    // Recovery after a compaction may compact again, including an
    // already-compacted history that still overflows, so it opts into
    // summary-only compaction. The auto path never does.
    const recoverOverflow = (input: Parameters<typeof compaction.compactAfterOverflow>[0]) =>
      compaction.compactAfterOverflow(input, { allowSummaryOnly: true })

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      promotion,
      step,
      remaining = MAX_OVERFLOW_COMPACTIONS - 1,
    ) {
      return yield* runTurnAttempt(sessionID, promotion, step, remaining > 0 ? recoverOverflow : undefined).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction") {
              if (remaining <= 0)
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, remaining - 1)
            }
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, remaining)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "StopAfterCompaction")
              return { needsContinuation: false, step: defect.transition.step }
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    let runDrain:
      | ((input: { readonly sessionID: SessionSchema.ID; readonly force: boolean }) => Effect.Effect<void, RunError>)
      | undefined

    // Nothing inside a parent's turn can interrupt a stalled subagent: only an
    // external interrupt reaches it. Racing the child's drain against its own
    // event stream bounds that wait, because silence ends the stream and the
    // lost race interrupts the drain. Without this, one wedged subagent holds
    // its parent's turn open indefinitely.
    const stalledSubagent = (sessionID: SessionSchema.ID) =>
      events.all().pipe(
        Stream.filter((event) => event.durable?.aggregateID === sessionID),
        Stream.timeout(SUBAGENT_SILENCE),
        Stream.runDrain,
      )

    const runSubagent = Effect.fnUntraced(function* (
      parentSessionID: SessionSchema.ID,
      request: {
        readonly agent: string
        readonly prompt: string
        readonly description: string
        readonly model?: ModelV2.Ref
        readonly files?: typeof Prompt.Type.files
        readonly agents?: typeof Prompt.Type.agents
        readonly taskId?: string
      },
    ) {
      const parent = yield* getSession(parentSessionID)
      if (parent.parentID !== undefined)
        return yield* new ToolFailure({ message: "Nested subagents are not supported." })
      const selection = yield* agents.select(request.agent)
      if (!selection.info) return yield* new ToolFailure({ message: `Unknown agent type: ${request.agent}` })
      const resumed = request.taskId ? yield* store.get(SessionSchema.ID.make(request.taskId)) : undefined
      const parentContext = yield* store.context(parentSessionID)
      const parentAssistant = parentContext.findLast((message) => message.type === "assistant")
      // Inherit the active turn, including a sampled model that changed after resolution.
      const parentAgent = yield* agents.select(parent.agent)
      const model = request.model ?? selection.info.model ?? (parentAssistant?.type === "assistant" ? parentAssistant.model : parent.model ?? parentAgent.info?.model)
      const child = resumed ?? (yield* creation.create({
        parentID: parentSessionID,
        agent: selection.id,
        location: parent.location,
        model,
      }))
      // Older children were created without a model and fell back to the Location default.
      if (resumed && !resumed.model && model)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: child.id,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(Date.now()),
          model,
        })
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: child.id,
        prompt: Prompt.make({ text: request.prompt, files: request.files, agents: request.agents }),
        delivery: "steer",
      })
      // A failed drain is observed through the child's projected history
      // below, so `Effect.exit` keeps the race from ending on a drain failure
      // and losing the outcome that decides between the two branches.
      const outcome = yield* Effect.race(
        runDrain!({ sessionID: child.id, force: true }).pipe(Effect.exit, Effect.as("drained" as const)),
        stalledSubagent(child.id).pipe(Effect.as("stalled" as const)),
      )
      if (outcome === "stalled")
        return yield* new ToolFailure({
          message: `Subagent produced no output for ${SUBAGENT_SILENCE_MINUTES} minutes and was interrupted. It may be stuck; retry it, or split the work into smaller tasks.`,
        })
      const context = yield* store.context(child.id)
      const assistant = context.findLast((message) => message.type === "assistant")
      if (assistant?.type === "assistant" && (assistant.error !== undefined || assistant.finish === "error"))
        return yield* new ToolFailure({
          message: `Subagent failed: ${assistant.error?.message ?? "provider error"}`,
        })
      const text =
        assistant?.type === "assistant"
          ? assistant.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
          : ""
      return { sessionID: child.id, text: text.trim().length > 0 ? text : "(no output)" }
    })

    const resolveMessageTarget = Effect.fnUntraced(function* (sender: SessionSchema.Info, to: string) {
      if (!to.startsWith("@")) return yield* store.get(SessionSchema.ID.make(to))
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.slug, to.slice(1)),
            eq(SessionTable.project_id, sender.projectID),
            isNull(SessionTable.time_archived),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? yield* store.get(row.id) : undefined
    })

    const runListSessions = Effect.fnUntraced(function* (senderSessionID: SessionSchema.ID) {
      const sender = yield* getSession(senderSessionID)
      const rows = yield* db
        .select({
          id: SessionTable.id,
          slug: SessionTable.slug,
          title: SessionTable.title,
          parent_id: SessionTable.parent_id,
        })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, sender.projectID),
            isNull(SessionTable.time_archived),
            ne(SessionTable.id, sender.id),
          ),
        )
        .orderBy(desc(SessionTable.time_updated))
        .limit(50)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        ...(row.parent_id === null ? {} : { parentID: row.parent_id }),
      }))
    })

    const runSendMessage = Effect.fnUntraced(function* (
      senderSessionID: SessionSchema.ID,
      request: { readonly to: string; readonly message: string },
      context: {
        readonly agent: AgentV2.ID
        readonly assistantMessageID: SessionMessage.ID
        readonly toolCallID: string
      },
      wake: ((sessionID: SessionSchema.ID) => Effect.Effect<void>) | undefined,
    ) {
      const sender = yield* getSession(senderSessionID)
      const target = yield* resolveMessageTarget(sender, request.to)
      if (!target) return yield* new ToolFailure({ message: `Unknown session: ${request.to}` })
      if (target.id === sender.id)
        return yield* new ToolFailure({ message: "Cannot send a message to the same session." })
      if (target.projectID !== sender.projectID)
        return yield* new ToolFailure({ message: "Cross-project session messaging is not allowed." })
      const pending = yield* SessionInput.countPending(db, target.id, "queue")
      if (pending >= SendMessageTool.MAX_INBOUND_QUEUE)
        return yield* new ToolFailure({
          message: `Session ${target.id} inbox is full (${pending} queued messages); try again later.`,
        })
      // Consulted as action `message` per target; the shared user-declined path
      // handles an explicit deny.
      yield* permission.assert({
        action: "message",
        resources: [target.id],
        save: [target.id],
        sessionID: sender.id,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: target.id,
        prompt: Prompt.make({ text: `<message from session="${sender.id}">\n${request.message}\n</message>` }),
        delivery: "queue",
      })
      // Waking routes through the process-local execution coordinator when the
      // runner was entered from a real drain; admit-only callers leave it durable.
      if (wake) yield* wake(target.id)
      return { sessionID: target.id }
    })

    // Provider and model-resolution failures are settled on the assistant message as
    // `step.failed`; any other drain failure would otherwise end the drain silently.
    const reportFailure = (sessionID: SessionSchema.ID, cause: Cause.Cause<RunError>) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.squash(cause)
      if (stepFailure(error)) return Effect.void
      return events
        .publish(SessionEvent.Failed, {
          sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          error: { type: "unknown", message: error instanceof Error ? error.message : String(error) },
          ...(typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
            ? { name: error._tag }
            : {}),
        })
        .pipe(Effect.asVoid)
    }

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly wake?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
    }) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const drainSession = yield* store.get(input.sessionID)
          const drainAgent = drainSession ? yield* agents.select(drainSession.agent) : undefined
          // Model-facing observation/control for background jobs owned by this
          // session, when the process provides the registry. It does not launch
          // jobs; a sandbox/parity launcher and durable restart recovery need a
          // separate slice.
          const jobsOption = yield* Effect.serviceOption(BackgroundJob.Service)
          const jobTools = Option.isSome(jobsOption)
            ? BackgroundJobTool.make({
                list: () =>
                  jobsOption.value
                    .list()
                    .pipe(Effect.map((jobs) => jobs.filter((job) => job.metadata?.sessionID === input.sessionID))),
                wait: (id, timeoutMs) =>
                  Effect.gen(function* () {
                    const job = yield* jobsOption.value.get(id)
                    if (!job || job.metadata?.sessionID !== input.sessionID) return { timedOut: false as const }
                    return yield* jobsOption.value.wait({ id, timeout: timeoutMs })
                  }),
                cancel: (id) =>
                  Effect.gen(function* () {
                    const job = yield* jobsOption.value.get(id)
                    if (!job || job.metadata?.sessionID !== input.sessionID) return undefined
                    return yield* jobsOption.value.cancel(id)
                  }),
              })
            : {}
          if (drainAgent?.info !== undefined)
            yield* tools
              .registerSession(input.sessionID, {
                ...jobTools,
                task: TaskTool.make((request) =>
                  runSubagent(input.sessionID, request).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure ? error : new ToolFailure({ message: "Subagent task failed" }),
                    ),
                  ),
                ),
                send_message: SendMessageTool.make((request, context) =>
                  runSendMessage(input.sessionID, request, context, input.wake).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure ? error : new ToolFailure({ message: "Session messaging failed" }),
                    ),
                  ),
                ),
                list_sessions: ListSessionsTool.make(() => runListSessions(input.sessionID)),
                goal: GoalTool.make((goal) =>
                  GoalTool.record(events, input.sessionID, goal).pipe(
                    Effect.mapError(() => new ToolFailure({ message: "Unable to record the goal" })),
                  ),
                ),
              })
              .pipe(Effect.orDie)
          const repeatedPrefix = `${input.sessionID}\u0000`
          for (const key of repeatedToolCalls.keys()) if (key.startsWith(repeatedPrefix)) repeatedToolCalls.delete(key)
          const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
          if (!input.force && !hasSteer && !hasQueue) return
          // Refuse to run a provider turn on a session whose history is still only
          // in the legacy V1 tables: the projected context would be empty and the
          // turn would silently drop everything recorded before the V2 runtime.
          const historyState = yield* store.historyState(input.sessionID)
          if (historyState === "legacy" || historyState === "mixed")
            return yield* new LegacyNotMigratedError({ sessionID: input.sessionID, state: historyState })
          const settings = yield* readSettings()
          let loopIterations = 0
          let lastTodoSignature: string | undefined
          let loopStalls = 0
          const exceeded = (session: SessionSchema.Info) =>
            settings.budget !== undefined && session.cost >= settings.budget
          const initial = yield* getSession(input.sessionID)
          if (exceeded(initial)) {
            yield* Effect.logWarning("session.budget-exceeded", {
              sessionID: input.sessionID,
              cost: initial.cost,
              budget: settings.budget,
            })
            return
          }
          yield* failInterruptedTools(input.sessionID)
          let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
          let shouldRun = input.force || hasSteer || hasQueue
          while (shouldRun) {
            const current = yield* getSession(input.sessionID)
            if (exceeded(current)) {
              yield* Effect.logWarning("session.budget-exceeded", {
                sessionID: input.sessionID,
                cost: current.cost,
                budget: settings.budget,
              })
              break
            }
            let needsContinuation = true
            let step = 1
            while (needsContinuation) {
              const result = yield* runTurn(input.sessionID, promotion, step)
              needsContinuation = result.needsContinuation
              step = result.step + 1
              promotion = "steer"
              if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
              // A model behind an OpenAI-compatible server can write its tool
              // call as plain text instead of emitting a structured call. The
              // turn then looks finished ("stop", no tool part) even though the
              // model meant to act, and once that raw text is in history the
              // model imitates it on every later turn. Nudge it to re-issue the
              // call through the tool-calling mechanism; after MAX_ATTEMPTS,
              // fail the assistant message so the stop is explained instead of
              // silently stalling.
              if (!needsContinuation) {
                const leak = yield* leakedToolCall(input.sessionID)
                if (leak && leak.attempts < ToolCallLeak.MAX_ATTEMPTS) {
                  yield* Effect.logWarning("session.tool-call-leak", {
                    sessionID: input.sessionID,
                    messageID: leak.messageID,
                    attempts: leak.attempts,
                  })
                  yield* events.publish(SessionEvent.Synthetic, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    messageID: SessionMessage.ID.create(),
                    text: ToolCallLeak.NUDGE,
                    metadata: { [ToolCallLeak.NUDGE_MARKER]: true },
                  })
                  needsContinuation = true
                } else if (leak) {
                  yield* Effect.logWarning("session.tool-call-leak-exhausted", {
                    sessionID: input.sessionID,
                    messageID: leak.messageID,
                    attempts: leak.attempts,
                  })
                  yield* events.publish(SessionEvent.Step.Failed, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    assistantMessageID: leak.messageID,
                    error: {
                      type: "unknown",
                      message:
                        "The model repeatedly wrote tool calls as plain text instead of using the tool-calling mechanism, so they were not executed. Check the inference server's tool-call parser configuration.",
                    },
                  })
                }
              }
            }
            shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
            if (!shouldRun && settings.loop !== undefined) {
              const current = yield* getSession(input.sessionID)
              if (exceeded(current)) {
                yield* Effect.logWarning("session.loop-stopped", { sessionID: input.sessionID, reason: "budget" })
              } else if (loopIterations >= settings.loop.maxIterations) {
                yield* Effect.logWarning("session.loop-stopped", {
                  sessionID: input.sessionID,
                  reason: "max-iterations",
                })
              } else {
                const list = yield* todos.get(input.sessionID)
                const open = list.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
                if (list.length > 0 && open.length > 0) {
                  const signature = JSON.stringify(list)
                  loopStalls = signature === lastTodoSignature ? loopStalls + 1 : 0
                  lastTodoSignature = signature
                  if (loopStalls >= LOOP_STALL_LIMIT) {
                    yield* Effect.logWarning("session.loop-stopped", {
                      sessionID: input.sessionID,
                      reason: "no-progress",
                    })
                  } else {
                    loopIterations += 1
                    yield* SessionInput.admit(db, events, {
                      id: SessionMessage.ID.create(),
                      sessionID: input.sessionID,
                      prompt: Prompt.make({ text: settings.loop.continuePrompt }),
                      delivery: "queue",
                    })
                    shouldRun = true
                  }
                }
              }
            }
            promotion = shouldRun ? "queue" : undefined
          }
        }),
      )
    }, (effect, input) => effect.pipe(Effect.tapCause((cause) => reportFailure(input.sessionID, cause))))
    runDrain = run

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    BashTool.executionNode,
    LocationMutation.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    SessionCreate.node,
    SessionTodo.node,
    PermissionV2.node,
    Blob.node,
    FSUtil.node,
    Image.node,
  ],
})

const stepFailure = (error: unknown) =>
  error instanceof LLMError ||
  error instanceof SessionRunnerModel.ModelNotSelectedError ||
  error instanceof SessionRunnerModel.ModelUnavailableError ||
  error instanceof SessionRunnerModel.VariantUnavailableError ||
  error instanceof SessionRunnerModel.UnsupportedApiError ||
  error instanceof Integration.AuthorizationError

/**
 * What a retry is retrying, in the shape both the durable `Retried` event and
 * the retry warning report.
 *
 * An HTTP-derived reason keeps its status on the captured response rather than
 * on itself, and a rate limit — the case this exists for — has no `status` of
 * its own at all, so reading only the reason's own field left every retried
 * turn recorded with no status code and no vendor request id.
 */
const retryDetail = (error: LLMError | SessionRunnerModel.Error) => {
  const reason = error instanceof LLMError ? error.reason : undefined
  const http = reason !== undefined && "http" in reason ? reason.http : undefined
  const rateLimit = reason !== undefined && "rateLimit" in reason ? reason.rateLimit : undefined
  const retryAfterMs = reason !== undefined && "retryAfterMs" in reason ? reason.retryAfterMs : undefined
  const metadata = {
    ...(http?.requestId === undefined ? {} : { requestId: http.requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs: String(retryAfterMs) }),
    ...Object.fromEntries(
      (["limit", "remaining", "reset"] as const).flatMap((group) =>
        Object.entries(rateLimit?.[group] ?? {}).map(([name, value]) => [`rateLimit.${group}.${name}`, value]),
      ),
    ),
  }
  return {
    message: error.message,
    // The retry policy already accepted this error, so the attempt is worth another.
    isRetryable: true,
    statusCode: (reason !== undefined && "status" in reason ? reason.status : undefined) ?? http?.response?.status,
    responseHeaders: http?.response?.headers,
    responseBody: http?.body,
    metadata: Object.keys(metadata).length === 0 ? undefined : metadata,
  }
}

/** The subset of a retry worth one warning line; the response body stays in the event, not the log. */
const retryLog = (error: LLMError | SessionRunnerModel.Error) => {
  const detail = retryDetail(error)
  return {
    reason: detail.message,
    status: detail.statusCode,
    requestId: detail.metadata?.requestId,
    retryAfterMs: detail.metadata?.retryAfterMs,
    bodyLength: detail.responseBody?.length,
  }
}
