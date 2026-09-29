import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolFailure,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@miao/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { Flag } from "../../flag/flag"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { TaskTool } from "../../tool/task"
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
import { Prompt } from "../prompt"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTodo } from "../todo"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { SessionRunnerMetrics } from "./metrics"
import { Snapshot } from "../../snapshot"
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
 *   - [ ] Bound provider retries and repeated identical tool calls.
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
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
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
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

/** Cap on how many times one identical (name, input) tool call may execute in a drain. */
const MAX_IDENTICAL_TOOL_CALLS = 5

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
      for (const entry of documents) {
        if (entry.info.cache?.ttl_seconds !== undefined) ttl = entry.info.cache.ttl_seconds
        if (entry.info.compaction?.prune !== undefined) prune = entry.info.compaction.prune
        if (entry.info.cost?.budget_usd !== undefined) budget = entry.info.cost.budget_usd
        if (entry.info.loop?.enabled === true)
          loop = {
            maxIterations: entry.info.loop.max_iterations ?? DEFAULT_LOOP_MAX_ITERATIONS,
            continuePrompt: entry.info.loop.continue_prompt ?? DEFAULT_LOOP_PROMPT,
          }
      }
      return { ttl, prune, budget, loop }
    })
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
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
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

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const resolved = yield* models.resolve(session)
      const model = resolved.model
      const summarizeModel = yield* models.resolveSmall(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(agent.info?.permissions, {
            codeMode: Flag.MIAO_EXPERIMENTAL_CODE_MODE,
            sessionID: session.id,
          })
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const settings = yield* readSettings()
      const prior = turns.get(session.id)
      const expectedRebuild = prior?.afterCompaction === true
      const warm = prior !== undefined && Date.now() - prior.at < WARM_WINDOW_MS
      turns.set(session.id, { at: Date.now(), afterCompaction: false })
      const messages = [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])]
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey } },
        cache: settings.ttl
          ? { tools: true, system: true, messages: "latest-user-message", ttlSeconds: settings.ttl }
          : undefined,
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: settings.prune ? SessionPrune.toolResults(messages) : messages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (SessionCompactRequest.consume(session.id)) {
        const compacted = yield* compaction.compactAfterOverflow({ sessionID: session.id, entries, model, summarizeModel, request })
        if (compacted) turns.set(session.id, { at: Date.now(), afterCompaction: true })
        return yield* Effect.die(stopAfterCompaction(currentStep))
      }
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, summarizeModel, request })) {
        turns.set(session.id, { at: Date.now(), afterCompaction: true })
        return yield* Effect.die(continueAfterCompaction(currentStep))
      }
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        cost: resolved.info.cost,
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let requestStartedAt: number | undefined
      let firstEventAt: number | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            firstEventAt ??= Date.now()
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
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
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          requestStartedAt = Date.now()
          const stream = yield* restore(providerStream).pipe(Effect.exit)
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
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
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
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: stepSettlement.cost,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
            yield* Effect.logInfo("session.turn", {
              sessionID: session.id,
              model: `${model.provider}/${model.id}`,
              ttftMs:
                requestStartedAt !== undefined && firstEventAt !== undefined ? firstEventAt - requestStartedAt : undefined,
              warm,
              expectedRebuild,
              cacheMiss: stepSettlement.tokens.cache.write > 0,
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
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
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

    const runSubagent = Effect.fnUntraced(function* (
      parentSessionID: SessionSchema.ID,
      request: { readonly agent: string; readonly prompt: string; readonly description: string; readonly taskId?: string },
    ) {
      const parent = yield* getSession(parentSessionID)
      if (parent.parentID !== undefined)
        return yield* new ToolFailure({ message: "Nested subagents are not supported." })
      const selection = yield* agents.select(request.agent)
      if (!selection.info) return yield* new ToolFailure({ message: `Unknown agent type: ${request.agent}` })
      const resumed = request.taskId ? yield* store.get(SessionSchema.ID.make(request.taskId)) : undefined
      const child =
        resumed ?? (yield* creation.create({ parentID: parentSessionID, agent: selection.id, location: parent.location }))
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: child.id,
        prompt: Prompt.make({ text: request.prompt }),
        delivery: "steer",
      })
      yield* runDrain!({ sessionID: child.id, force: true })
      const context = yield* store.context(child.id)
      const assistant = context.findLast((message) => message.type === "assistant")
      const text =
        assistant?.type === "assistant"
          ? assistant.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
          : ""
      return { sessionID: child.id, text: text.trim().length > 0 ? text : "(no output)" }
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const drainSession = yield* store.get(input.sessionID)
          const drainAgent = drainSession ? yield* agents.select(drainSession.agent) : undefined
          if (drainAgent?.info !== undefined)
            yield* tools
              .registerSession(input.sessionID, {
                task: TaskTool.make((request) =>
                  runSubagent(input.sessionID, request).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure ? error : new ToolFailure({ message: "Subagent task failed" }),
                    ),
                  ),
                ),
              })
              .pipe(Effect.orDie)
          const repeatedPrefix = `${input.sessionID}\u0000`
      for (const key of repeatedToolCalls.keys()) if (key.startsWith(repeatedPrefix)) repeatedToolCalls.delete(key)
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
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
                yield* Effect.logWarning("session.loop-stopped", { sessionID: input.sessionID, reason: "no-progress" })
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
    })
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
  ],
})
