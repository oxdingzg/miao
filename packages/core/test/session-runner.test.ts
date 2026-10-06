import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  InvalidRequestReason,
  RateLimitReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  type LLMClientShape,
  type LLMRequest,
} from "@miao/llm"
import * as OpenAIChat from "@miao/llm/protocols/openai-chat"
import { Database } from "@miao/core/database/database"
import { makeLocationNode } from "@miao/core/effect/app-node"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { PermissionV2 } from "@miao/core/permission"
import { EventTable } from "@miao/core/event/sql"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { QuestionV2 } from "@miao/core/question"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionTodo } from "@miao/core/session/todo"
import { Snapshot } from "@miao/core/snapshot"
import { ContextSnapshotDecodeError, LegacyNotMigratedError } from "@miao/core/session/error"
import { SessionEvent } from "@miao/core/session/event"
import { SessionInput } from "@miao/core/session/input"
import { SessionMessage } from "@miao/core/session/message"
import { Prompt } from "@miao/core/session/prompt"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionRunCoordinator } from "@miao/core/session/run-coordinator"
import { SessionRunner } from "@miao/core/session/runner"
import * as SessionRunnerLLM from "@miao/core/session/runner/llm"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { BashTool } from "@miao/core/tool/bash"
import { ToolCallLeak } from "@miao/core/session/tool-call-leak"
import { SessionOutputGuard } from "@miao/core/session/runner/output-guard"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { SendMessageTool } from "@miao/core/tool/send-message"
import { AgentV2 } from "@miao/core/agent"
import { CommandV2 } from "@miao/core/command"
import { Config } from "@miao/core/config"
import { ConfigCompaction } from "@miao/core/config/compaction"
import { ConfigLoop } from "@miao/core/config/loop"
import { Tool } from "@miao/core/tool/tool"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { SessionDelegation } from "@miao/core/session/delegation"
import { SessionDelegationStore } from "@miao/core/session/delegation-store"
import { SystemContext } from "@miao/core/system-context"
import { OutputLanguage } from "@miao/core/system-context/output-language"
import { PlanIntent } from "@miao/core/system-context/plan-intent"
import DEFAULT_PERSONA from "@miao/core/system-context/persona/default.txt"
import { SystemContextRegistry } from "@miao/core/system-context/registry"
import { SkillGuidance } from "@miao/core/skill/guidance"
import { ReferenceGuidance } from "@miao/core/reference/guidance"
import { ModelV2 } from "@miao/core/model"
import { LocationServiceMap } from "@miao/core/location-service-map"
import { Location } from "@miao/core/location"
import { ProviderV2 } from "@miao/core/provider"
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess } from "effect/unstable/process"
import { asc, eq } from "drizzle-orm"
import { AppProcess } from "@miao/core/process"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let responseFor: ((request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>) | undefined
// Title requests run on their own fiber; answering them separately keeps ordering deterministic.
const TITLE_SYSTEM = "You generate titles"
let titleResponse: LLMEvent[] | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (titleResponse && request.system.some((part) => part.text === TITLE_SYSTEM))
        return Stream.fromIterable(titleResponse)
      if (responseFor) return responseFor(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
// The fake models name no family, so the default persona leads every request.
const persona = DEFAULT_PERSONA
// Always trailing the context baseline, in this order.
const language = OutputLanguage.instruction
const planIntent = PlanIntent.instruction
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permissionAsserts: Array<{ action: string; resources: readonly string[] }> = []
let commandDeniedAction: string | undefined
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => {
      permissionAsserts.push({ action: input.action, resources: [...input.resources] })
      // The built-in bash tool asserts "bash" for the command and
      // "external_directory" for a workdir outside the bound Location; the test
      // only cares that the OS process it spawns is cleaned up.
      if (input.action === commandDeniedAction) return Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
      return input.action === "task" || input.action === "read" || input.action === "message" || input.action === "bash" || input.action === "external_directory"
        ? Effect.void
        : Effect.die("unused")
    },
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })

// A tool that spawns a real process group, so an interrupted turn can be
// checked against the OS instead of against durable state alone. It is
// provided per test rather than through the shared layer: a registered tool
// changes the definitions sent to the provider, which other tests assert on.
const spawnPidFile = `${os.tmpdir()}/miao-runner-spawn-${process.pid}.pid`
const spawnTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const registry = yield* ToolRegistry.Service
    yield* registry.register({
      spawn: Tool.make({
        description: "Run a shell command",
        input: Schema.Struct({ command: Schema.String }),
        output: Schema.Struct({ output: Schema.String }),
        execute: ({ command }) =>
          appProcess
            .run(
              ChildProcess.make(command, [], {
                shell: process.platform === "win32" ? undefined : "/bin/sh",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              }),
              { combineOutput: true, timeout: Duration.minutes(5) },
            )
            .pipe(
              Effect.map((result) => ({ output: String(result.output ?? "") })),
              Effect.orDie,
            ),
      }),
    })
  }),
)

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Reads the pid the spawned shell recorded, waiting for the file to appear.
const waitForPid = (file: string) =>
  Effect.gen(function* () {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))
      const pid = Number(text.trim())
      if (Number.isInteger(pid) && pid > 0) return pid
      yield* Effect.promise(() => sleep(20))
    }
    return yield* Effect.die(new Error(`Spawned process never reported a pid to ${file}`))
  })

const waitForProcessExit = (pid: number) =>
  Effect.promise(async () => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      if (!processAlive(pid)) return true
      await sleep(50)
    }
    return !processAlive(pid)
  })

const childPids = (pid: number) =>
  Bun.spawnSync(["pgrep", "-P", String(pid)])
    .stdout.toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)

// The shell a real command spawns keeps a foreground child; a group kill has to
// take that child too, or the work outlives the turn as an orphan.
const waitForChild = (pid: number) =>
  Effect.gen(function* () {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      const child = childPids(pid)[0]
      if (child !== undefined) return child
      yield* Effect.promise(() => sleep(20))
    }
    return yield* Effect.die(new Error(`Process ${pid} never spawned a child`))
  })

let modelResolveHook: Effect.Effect<void, SessionRunnerModel.Error> = Effect.void
let modelResolveFailure: SessionRunnerModel.Error | undefined
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveFailure ? Effect.fail(modelResolveFailure) : modelResolveHook.pipe(Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel)),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
            loop: new ConfigLoop.Info({ enabled: true, max_iterations: 10, continue_prompt: "keep going" }),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(
  LayerNode.group([SessionRunnerLLM.node, Database.node, EventV2.node, SessionStore.node]), [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
],
)
const makeExecution = (maxConcurrent?: number) =>
  Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
    let wake: (sessionID: SessionV2.ID) => Effect.Effect<void> = () => Effect.void
      let delegation: SessionDelegation.API | undefined
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        maxConcurrent,
        drain: (sessionID, force) => sessionRunner.run({ sessionID, force, wake, delegation }),
    })
    wake = coordinator.wake
      delegation = yield* SessionDelegation.make({
        db,
        events,
        store,
        wake: coordinator.wake,
        wait: coordinator.awaitIdle,
        executions: coordinator.executions,
        interruptIf: coordinator.interruptIf,
      })
    return SessionExecution.Service.of({
      active: coordinator.active,
      executions: coordinator.executions,
      status: coordinator.status,
      interruptIf: coordinator.interruptIf,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      wait: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const appNodes = [
  Database.node,
  EventV2.node,
  QuestionV2.node,
  SessionProjector.node,
  SessionStore.node,
  SessionTodo.node,
  ApplicationTools.node,
  AgentV2.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  echoNode,
  AppProcess.node,
  SessionRunnerModel.node,
  SystemContextRegistry.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  Config.node,
  CommandV2.node,
  LocationServiceMap.node,
  Snapshot.node,
  SessionRunnerLLM.node,
  SessionExecution.node,
  SessionV2.node,
]
const location = (directory: string): LayerNode.Replacement => [
  Location.node,
  Location.boundNode({ directory: AbsolutePath.make(directory) }),
]
const execution = makeExecution()
const appOverrides = (bound: LayerNode.Replacement): LayerNode.Replacements => [
  [LayerNodePlatform.llmClient, client],
  [PermissionV2.node, permission],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  bound,
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Snapshot.node, Snapshot.noopLayer],
  [SessionExecution.node, execution],
  [Config.node, config],
]
const it = testEffect(AppNodeBuilder.build(LayerNode.group(appNodes), appOverrides(location("/project"))))
const itWithSinglePermit = testEffect(
  AppNodeBuilder.build(LayerNode.group(appNodes), [
    ...appOverrides(location("/project")).filter(([node]) => node !== SessionExecution.node),
    [SessionExecution.node, makeExecution(1)],
  ]),
)
// A turn that goes through the shipped bash tool needs the built-in registered on
// top of the harness layer; the base layer only provides the registry itself. The
// tool also resolves its workdir through the real filesystem, so this harness has
// to bind a Location that exists on disk.
const bashLocation = mkdtempSync(join(os.tmpdir(), "miao-bash-harness-"))
const itWithBash = testEffect(
  AppNodeBuilder.build(LayerNode.group([...appNodes, BashTool.node]), appOverrides(location(bashLocation))),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

let todoBaseline = ""
const setup = Effect.gen(function* () {
  const todos = yield* SessionTodo.Service
  todoBaseline = (yield* SystemContext.initialize(SessionTodo.context(todos, sessionID))).baseline
  const { db } = yield* Database.Service
  requests.length = 0
  response = []
  commandDeniedAction = undefined
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveFailure = undefined
  modelResolveHook = Effect.void
  currentModel = model
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  responseFor = undefined
  titleResponse = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  permissionAsserts.length = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [fixture.expectedContent],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  itWithSinglePermit.effect("delivers a background report once after an idle parent, with one coordinator permit", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const db = (yield* Database.Service).db
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const childGate = yield* Deferred.make<void>()
      const childStarted = yield* Deferred.make<void>()
      const delivered = yield* Deferred.make<void>()
      let parentTurns = 0
      const textTurn = (text: string) =>
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "report" }),
          LLMEvent.textDelta({ id: "report", text }),
          LLMEvent.textEnd({ id: "report" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      responseFor = (request) => {
        if (JSON.stringify(request.messages.filter((m) => m.role === "user")).includes("UNIQUE CHILD PROMPT"))
          return Stream.unwrap(
            Deferred.succeed(childStarted, undefined).pipe(
              Effect.andThen(Deferred.await(childGate)),
              Effect.as(textTurn("VERBATIM CHILD REPORT")),
            ),
          )
        parentTurns += 1
        if (parentTurns === 1)
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "background-call",
              name: "task",
              input: {
                description: "background test",
                prompt: "UNIQUE CHILD PROMPT",
                subagent_type: "build",
                background: true,
              },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
        if (JSON.stringify(request.messages).includes("VERBATIM CHILD REPORT"))
          return Stream.unwrap(Deferred.succeed(delivered, undefined).pipe(Effect.as(textTurn("Report received"))))
        return textTurn("Parent continued independently")
      }
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate in background" }), resume: false })
      yield* session.resume(sessionID)
      expect(parentTurns).toBe(2)
      yield* Deferred.await(childStarted)
      const tasks = yield* SessionDelegationStore.list(db, sessionID)
      expect(tasks).toHaveLength(1)
      expect(tasks[0].status).toBe("running")
      const context = yield* session.context(sessionID)
      expect(
        context
          .flatMap((m) => (m.type === "assistant" ? m.content : []))
          .find((p) => p.type === "tool" && p.name === "task"),
      ).toMatchObject({ state: { status: "completed", structured: { background: true, taskID: tasks[0].id } } })
      yield* Deferred.succeed(childGate, undefined)
      yield* Deferred.await(delivered)
      yield* execution.wait(sessionID)
      expect(parentTurns).toBe(3)
      expect((yield* SessionDelegationStore.get(db, sessionID, tasks[0].id))?.result).toBe("VERBATIM CHILD REPORT")
      expect(yield* SessionDelegationStore.hasNotifications(db, sessionID)).toBe(false)
      const after = yield* session.context(sessionID)
      expect(after.filter((m) => m.type === "synthetic" && m.metadata?.backgroundTask)).toHaveLength(1)
      yield* execution.wake(sessionID)
      yield* execution.wait(sessionID)
      expect(parentTurns).toBe(3)
    }),
  )

  it.effect(
    "enforces background invocation identity, ownership and caps, and cancels only its observed execution",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        const waiting = yield* Deferred.make<void>()
        const woke = yield* Deferred.make<void>()
        const wakes: SessionV2.ID[] = []
        const interrupts: string[] = []
        let creates = 0
        const child = yield* session.create({
          parentID: sessionID,
          agent: AgentV2.ID.make("build"),
          location: { directory: AbsolutePath.make("/project") },
        })
        const manager = yield* SessionDelegation.make({
          db,
          events,
          store,
          maximum: 1,
          wake: (id) =>
            Effect.sync(() => {
              wakes.push(id)
            }).pipe(Effect.andThen(Deferred.succeed(woke, undefined)), Effect.asVoid),
          wait: () => Deferred.await(waiting),
          executions: Effect.succeed(new Map([[child.id, "owned-execution"]])),
          interruptIf: (id, execution) =>
            Effect.sync(() => {
              interrupts.push(`${id}:${execution}`)
              return true
            }),
        })
        const request = {
          id: "stable-invocation",
          sessionID,
          agent: "build",
          prompt: "Do work",
          description: "work",
          createChild: () =>
            Effect.sync(() => {
              creates += 1
              return child
            }),
        }
        const started = yield* manager.start(request)
        yield* Deferred.await(woke)
        expect((yield* manager.start(request)).taskID).toBe(started.taskID)
        expect(creates).toBe(1)
        expect((yield* manager.start({ ...request, prompt: "conflict" }).pipe(Effect.flip)).message).toContain(
          "conflicting",
        )
        expect((yield* manager.start({ ...request, id: "second" }).pipe(Effect.flip)).message).toContain("active")
        expect(yield* manager.result(otherSessionID, started.taskID)).toBeUndefined()
        expect(yield* manager.cancel(otherSessionID, started.taskID)).toBe(false)
        expect(yield* manager.cancel(sessionID, started.taskID)).toBe(true)
        expect(yield* manager.cancel(sessionID, started.taskID)).toBe(false)
        expect(interrupts).toEqual([`${child.id}:owned-execution`])
        expect((yield* manager.result(sessionID, started.taskID))?.status).toBe("cancelled")
        expect(yield* SessionDelegationStore.notificationCount(db, sessionID)).toBe(1)
        yield* Deferred.succeed(waiting, undefined)
        yield* Effect.yieldNow
        expect((yield* manager.result(sessionID, started.taskID))?.status).toBe("cancelled")
        expect(wakes.filter((id) => id === child.id)).toHaveLength(1)
        yield* insertSession(otherSessionID)
        expect(
          (yield* manager.start({ ...request, id: "foreign", sessionID: otherSessionID }).pipe(Effect.flip)).message,
        ).toContain("another Session/project")
      }),
  )

  it.effect("promotes background reports at a safe boundary without resetting the human step allowance", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => editor.update(AgentV2.ID.make("build"), (agent) => { agent.steps = 2 }))
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const child = yield* session.create({ parentID: sessionID, agent: AgentV2.ID.make("build"), location: { directory: AbsolutePath.make("/project") } })
      yield* events.publish(SessionEvent.DelegationStarted, {
        sessionID, id: "step-report", childSessionID: child.id, promptMessageID: SessionMessage.ID.create(),
        agent: "build", prompt: "Find facts", description: "facts", owner: "finished-owner", timestamp: yield* DateTime.now,
      })
      yield* events.publish(SessionEvent.DelegationEnded, {
        sessionID, id: "step-report", status: "completed", text: "BOUNDARY REPORT", timestamp: yield* DateTime.now,
      })
      responses = [[
        LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "before-report", name: "echo", input: { text: "work" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" }),
      ], [LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" })]]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Human instruction" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0].messages)).not.toContain("BOUNDARY REPORT")
      expect(JSON.stringify(requests[1].messages)).toContain("BOUNDARY REPORT")
      expect(requests[1].toolChoice).toMatchObject({ type: "none" })
      expect(requests[1].tools).toEqual([])
    }),
  )

  it.effect("reconciles lost delegation owners without executing children and promotes one durable notification", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const db = (yield* Database.Service).db
      const child = yield* session.create({
        parentID: sessionID,
        agent: AgentV2.ID.make("build"),
        location: { directory: AbsolutePath.make("/project") },
      })
      yield* events.publish(SessionEvent.DelegationStarted, {
        sessionID,
        id: "lost-task",
        childSessionID: child.id,
        promptMessageID: SessionMessage.ID.create(),
        agent: "build",
        prompt: "Never replay",
        description: "lost owner",
        owner: "dead-runtime",
        timestamp: yield* DateTime.now,
      })
      yield* SessionDelegationStore.recover(db, events, sessionID, "new-owner", () => false)
      yield* SessionDelegationStore.recover(db, events, sessionID, "new-owner", () => false)
      expect((yield* SessionDelegationStore.get(db, sessionID, "lost-task"))?.status).toBe("interrupted")
      expect(yield* SessionDelegationStore.get(db, child.id, "lost-task")).toBeUndefined()
      expect(yield* SessionDelegationStore.notificationCount(db, sessionID)).toBe(1)
      yield* events.publish(SessionEvent.DelegationEnded, {
        sessionID,
        id: "lost-task",
        status: "completed",
        text: "Late report",
        timestamp: yield* DateTime.now,
      })
      expect((yield* SessionDelegationStore.get(db, sessionID, "lost-task"))?.status).toBe("interrupted")
      expect(yield* SessionDelegationStore.promoteNext(db, events, sessionID)).toBe(true)
      expect(yield* SessionDelegationStore.promoteNext(db, events, sessionID)).toBe(false)
      expect(
        (yield* session.context(sessionID)).filter((m) => m.type === "synthetic" && m.metadata?.backgroundTask),
      ).toHaveLength(1)
      expect(yield* session.context(child.id)).toHaveLength(0)
    }),
  )

  it.effect("persists model resolution errors as a visible failed assistant", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const failure = new SessionRunnerModel.VariantUnavailableError({ providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-6.1-sol"), variant: ModelV2.VariantID.make("medium") })
      modelResolveFailure = failure
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "hi" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ type: "assistant", error: { message: failure.message } })
    }).pipe(Effect.ensuring(Effect.sync(() => { modelResolveFailure = undefined }))),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
          progress: expect.any(Function),
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.effect("sends a PDF attachment the route cannot carry as a note naming its local path", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      yield* session.prompt({
        sessionID,
        prompt: {
          text: "Summarize [PDF 1]",
          files: [{ uri: "data:application/pdf;base64,JVBERi0=", name: "report.pdf", path: "/home/me/report.pdf" }],
        },
      })

      expect(requests).toHaveLength(1)
      const content = requests[0]!.messages.find((message) => message.role === "user")!.content
      expect(content.some((part) => part.type === "media")).toBe(false)
      const note = content.find((part) => part.type === "text" && part.text.includes("report.pdf"))
      expect(note?.type === "text" ? note.text : "").toContain("(local file: /home/me/report.pdf)")
      // The OpenAI Chat body builds; before, lowering threw "does not support media type application/pdf".
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(requests[0]!)
      expect(JSON.stringify(prepared.body.messages)).toContain("pdftotext")
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("observes current todos across resumes and compaction without auto-completing work", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const todos = yield* SessionTodo.Service
      const events = yield* EventV2.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "release acceptance", status: "in_progress", priority: "high" }],
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain("release acceptance")
      expect((yield* todos.get(sessionID))[0]?.status).toBe("in_progress")
      yield* todos.update({
        sessionID,
        todos: [{ content: "release acceptance", status: "completed", priority: "high" }],
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.flatMap(systemTexts)).toContainEqual(expect.stringContaining('"status": "completed"'))
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Resume after compacting" }), resume: false })
      yield* session.resume(sessionID)
      expect(
        requests
          .at(-1)
          ?.system.map((part) => part.text)
          .join("\n"),
      ).toContain('"status": "completed"')
      expect(
        requests
          .at(-1)
          ?.system.map((part) => part.text)
          .join("\n"),
      ).not.toContain('"status": "in_progress"')
    }),
  )

  itWithBash.live("admits commands before side effects and prepares shell/files exactly once across retries", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ directory: bashLocation }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => editor.update(AgentV2.ID.make("build"), (agent) => { agent.mode = "primary" }))
      const commands = yield* CommandV2.Service
      yield* commands.transform((editor) => editor.update("daily", (command) => {
        command.template = `Inspect !\`"${process.execPath}" "${join(import.meta.dir, "fixture/command-effect.ts")}"\` @command-file.txt`
      }))
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(bashLocation) }))))
      yield* Effect.promise(() => fs.writeFile(join(bashLocation, "command-count.txt"), "0"))
      yield* Effect.promise(() => fs.writeFile(join(bashLocation, "command-file.txt"), "attached file content"))
      const id = SessionMessage.ID.create()
      requests.length = 0
      yield* session.command({ id, sessionID, command: "daily", arguments: "", resume: false })
      expect(yield* Effect.promise(() => fs.readFile(join(bashLocation, "command-count.txt"), "utf8"))).toBe("0")
      expect((yield* session.inputs({ sessionID, limit: 10 })).inputs).toHaveLength(1)
      yield* session.resume(sessionID)
      expect(yield* Effect.promise(() => fs.readFile(join(bashLocation, "command-count.txt"), "utf8"))).toBe("1")
      const user = (yield* session.context(sessionID)).find((message) => message.id === id)
      expect(user).toMatchObject({ type: "user", text: expect.stringContaining("ready"), commandState: "completed" })
      expect(user?.type === "user" ? user.files?.[0]?.name : undefined).toBe("command-file.txt")
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("attached file content")
      expect(permissionAsserts.map((input) => input.action)).toEqual(expect.arrayContaining(["bash", "read"]))
      yield* session.command({ id, sessionID, command: "daily", arguments: "", resume: false })
      yield* session.resume(sessionID)
      expect(yield* Effect.promise(() => fs.readFile(join(bashLocation, "command-count.txt"), "utf8"))).toBe("1")
      expect(Exit.isFailure(yield* session.command({ id, sessionID, command: "daily", arguments: "different", resume: false }).pipe(Effect.exit))).toBe(true)
    }),
  )

  itWithBash.live("refuses denied command shell effects and settles its durable receipt", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ directory: bashLocation }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => editor.update(AgentV2.ID.make("build"), (agent) => { agent.mode = "primary" }))
      const commands = yield* CommandV2.Service
      yield* commands.transform((editor) => editor.update("denied", (command) => {
        command.template = `!\`"${process.execPath}" "${join(import.meta.dir, "fixture/command-effect.ts")}"\``
      }))
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(bashLocation) }))))
      const session = yield* SessionV2.Service
      commandDeniedAction = "bash"
      yield* Effect.promise(() => fs.writeFile(join(bashLocation, "command-count.txt"), "0"))
      yield* session.command({ sessionID, command: "denied", arguments: "", resume: false })
      yield* session.resume(sessionID)
      expect(yield* Effect.promise(() => fs.readFile(join(bashLocation, "command-count.txt"), "utf8"))).toBe("0")
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toEqual(expect.arrayContaining([expect.objectContaining({ commandState: "failed" })]))
    }),
  )

  itWithBash.live("does not replay a command whose preparation was dispatched but has no durable result", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ directory: bashLocation }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.create()
      yield* Effect.promise(() => fs.writeFile(join(bashLocation, "command-count.txt"), "0"))
      yield* SessionInput.admit(database.db, events, { id, sessionID, delivery: "steer", prompt: Prompt.make({
        text: `!\`"${process.execPath}" "${join(import.meta.dir, "fixture/command-effect.ts")}"\``,
        command: { name: "unknown", arguments: "", subtask: false },
      }) })
      yield* SessionInput.promoteSteers(database.db, events, sessionID, yield* EventV2.latestSequence(database.db, sessionID))
      yield* events.publish(SessionEvent.Command.Started, { sessionID, messageID: id, timestamp: yield* DateTime.now })
      yield* session.resume(sessionID)
      expect(yield* Effect.promise(() => fs.readFile(join(bashLocation, "command-count.txt"), "utf8"))).toBe("0")
      expect((yield* session.context(sessionID)).find((message) => message.id === id)).toMatchObject({ commandState: "failed", commandError: expect.stringContaining("unknown") })
    }),
  )

  itWithBash.live("dispatches an explicit command subtask without changing the parent agent or model", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ directory: bashLocation }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const parent = yield* session.get(sessionID)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => editor.update(AgentV2.ID.make("reviewer"), (agent) => { agent.mode = "subagent" }))
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) => editor.update(AgentV2.ID.make("reviewer"), (agent) => { agent.mode = "subagent" }))
        const commands = yield* CommandV2.Service
        yield* commands.transform((editor) => editor.update("review", (command) => {
          command.template = "Review this scope"
          command.agent = "reviewer"
          command.model = ModelV2.Ref.make({ id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") })
        }))
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(bashLocation) }))))
      const id = SessionMessage.ID.create()
      yield* session.command({ id, sessionID, command: "review", arguments: "", resume: false })
      responses = [fragmentFixture("text", "command-child", ["Child review complete"]).completeEvents, fragmentFixture("text", "command-parent", ["Review summary"]).completeEvents]
      requests.length = 0
      yield* session.resume(sessionID)
      const children = yield* database.db.select().from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all().pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      expect(children[0]?.agent).toBe("reviewer")
      expect(children[0]?.model?.id).toBe("replacement")
      expect(requests[0]?.model).toBe(replacementModel)
      expect(yield* session.get(sessionID)).toMatchObject({ agent: parent.agent, model: parent.model })
      expect((yield* session.context(sessionID)).find((message) => message.id === id)).toMatchObject({ commandState: "completed", text: expect.stringContaining("Child review complete") })
      expect(requests).toHaveLength(2)
    }),
  )

  itWithBash.live("asks external-directory permission before reading a command file and can refuse it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(join(os.tmpdir(), "miao-command-external-"))),
      (outside) => Effect.gen(function* () {
        yield* setup
        const database = yield* Database.Service
        yield* database.db.update(SessionTable).set({ directory: bashLocation }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const target = join(outside, "secret.txt")
        yield* Effect.promise(() => fs.writeFile(target, "external secret"))
        commandDeniedAction = "external_directory"
        const id = SessionMessage.ID.create()
        yield* SessionInput.admit(database.db, events, { id, sessionID, delivery: "steer", prompt: Prompt.make({ text: `Inspect @${target}`, command: { name: "external", arguments: "", subtask: false } }) })
        requests.length = 0
        yield* session.resume(sessionID)
        expect(permissionAsserts.map((input) => input.action)).toEqual(["external_directory"])
        expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("external secret")
        expect((yield* session.context(sessionID)).find((message) => message.id === id)).toMatchObject({ commandState: "failed" })
      }),
      (outside) => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })),
    ),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", `Initial context\n\n${todoBaseline}`, planIntent, language])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", `Initial context\n\n${todoBaseline}`, planIntent, language])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", `Initial context\n\n${todoBaseline}`, planIntent, language])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\nBuild skills\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\nBuild skills\n\n${todoBaseline}`, planIntent, language],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\nBuild skills\n\n${todoBaseline}`, planIntent, language],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([[persona, `Initial context\n\n${todoBaseline}`, planIntent, language]])
    }),
  )

  it.effect("leads the request with the model family persona of the resolved model", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      // A role-free agent inherits the family persona, which leads the request
      // ahead of the durable context baseline.
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([persona, `Initial context\n\n${todoBaseline}`, planIntent, language])
      expect((yield* agents.get(AgentV2.defaultID))?.system).toBeUndefined()
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Replacement context\n\n${todoBaseline}`, planIntent, language],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.http?.headers)).toEqual([
        {
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
        {
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
      ])
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the task",
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<prior-summary>\n## Objective\n- Preserve the task\n</prior-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the updated task",
      })
    }),
  )

  it.effect("forces one compaction on request and ends without a provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      response = fragmentFixture("text", "text-recent", ["Recent answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [fragmentFixture("text", "text-forced", ["## Objective\n- Forced summary"]).completeEvents]

      yield* session.compact({ sessionID })

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0])[0]).toContain("Earlier question")
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context[0]).toMatchObject({ type: "compaction", summary: "## Objective\n- Forced summary" })
    }),
  )

  it.effect("retains only complete serialized messages during compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const earlier = `EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`
      const recent = `RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: earlier }), resume: false })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: recent }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/EARLIER_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(`EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`)
      expect(summary).not.toContain("RECENT_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_END")
      expect(continuation).toContain("<recent-context>\n[Assistant]: Earlier answer")
      expect(continuation).toContain(`RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`)
    }),
  )

  it.effect("summarizes an oversized newest message without retaining a fragment", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      const oversized = `OVERSIZED_BOUNDARY ${"x".repeat(4_500)} OVERSIZED_END`
      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: oversized }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/OVERSIZED_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(oversized)
      expect(continuation).not.toContain("OVERSIZED_BOUNDARY")
      expect(continuation).not.toContain("OVERSIZED_END")
      expect(continuation).toContain("<recent-context>\n\n</recent-context>")
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("recovers twice then persists a third context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary-1", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Recover twice"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(5)
      expect(userTexts(requests[3])[0]).toContain("Recover once")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers twice and finishes when the second compaction fits", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary-1", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Recover twice"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Objective\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([persona, `Initial context\n\n${todoBaseline}`, planIntent, language])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("bounds repeated identical tool calls within a drain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Repeat" }), resume: false })

      requests.length = 0
      executions.length = 0
      const repeatCall = (index: number) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-repeat-${index}`, name: "echo", input: { text: "repeat" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responses = [
        ...Array.from({ length: 6 }, (_unused, index) => repeatCall(index)),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["repeat", "repeat", "repeat", "repeat", "repeat"])
    }),
  )

  it.effect("runs a tool call the provider replays only once", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo once" }), resume: false })

      requests.length = 0
      executions.length = 0
      const call = LLMEvent.toolCall({ id: "call-replayed", name: "echo", input: { text: "once" } })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          call,
          call,
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["once"])
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      const last = context.at(-1)
      expect(last?.type === "assistant" ? last.content.at(-1) : undefined).toMatchObject({ type: "text", text: "Done" })
    }),
  )

  it.effect("nudges the model to retry when a tool call leaks as text", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "List files" }), resume: false })

      requests.length = 0
      const leaked =
        'Let me look.\n< | DSML | invoke name="bash">\n<parameter name="command">ls</parameter>\n</ | DSML | invoke>'
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-leak" }),
          LLMEvent.textDelta({ id: "text-leak", text: leaked }),
          LLMEvent.textEnd({ id: "text-leak" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      // The leak triggered a second provider turn carrying the nudge.
      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toContain(ToolCallLeak.NUDGE)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "synthetic" && message.text === ToolCallLeak.NUDGE)).toBe(true)
    }),
  )

  it.effect("recovers a dangling parameter tail through a structured call without replaying earlier tools", () =>
    Effect.gen(function* () {
      yield* setup
      executions.length = 0
      requests.length = 0
      const session = yield* SessionV2.Service
      const toolTurn = (id: string, text: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id, name: "echo", input: { text } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responses = [
        toolTurn("before", "before"),
        fragmentFixture("text", "dangling", ['Now add the helper.\n\n<parameter name="bash">']).completeEvents,
        toolTurn("after", "after"),
        fragmentFixture("text", "done", ["Done"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Make both changes" }), resume: false })
      yield* session.resume(sessionID)

      expect(executions).toEqual(["before", "after"])
      expect(requests).toHaveLength(4)
      expect(userTexts(requests[2])).toContain(ToolCallLeak.NUDGE)
      expect(JSON.stringify(requests[2].messages)).not.toContain('<parameter name="bash">')
      expect(JSON.stringify(requests[2].messages)).toContain(ToolCallLeak.NEUTRALIZED)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "assistant" && message.content.some(
        (part) => part.type === "text" && part.text.includes('<parameter name="bash">'),
      ))).toBe(true)
    }),
  )

  it.effect("neutralizes a leaked assistant message in later projections", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "List files" }), resume: false })

      requests.length = 0
      const leaked =
        'Let me look.\n< | DSML | invoke name="bash">\n<parameter name="command">ls</parameter>\n</ | DSML | invoke>'
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-leak" }),
          LLMEvent.textDelta({ id: "text-leak", text: leaked }),
          LLMEvent.textEnd({ id: "text-leak" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests.flatMap((request) => request.messages).length).toBeGreaterThan(0)
      // The leaked turn is already neutralized in the request it nudge-triggered.
      expect(JSON.stringify(requests.flatMap((request) => request.messages))).not.toContain("invoke name=")

      // A later turn must project the leaked body as the placeholder, not the raw block.
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-later" }),
          LLMEvent.textDelta({ id: "text-later", text: "Sure" }),
          LLMEvent.textEnd({ id: "text-later" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      const projected = JSON.stringify(requests.at(-1)?.messages ?? [])
      expect(projected).not.toContain("invoke name=")
      expect(projected).toContain(ToolCallLeak.NEUTRALIZED)
      // The durable row still holds the original text for the user.
      const stored = yield* session.context(sessionID)
      expect(
        stored.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((item) => item.type === "text" && item.text.includes("invoke name=")),
        ),
      ).toBe(true)
    }),
  )

  it.effect("stops with a visible error when a tool call keeps leaking as text", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "List files" }), resume: false })

      requests.length = 0
      const leaked =
        '<tool_calls>\n<invoke name="bash"><parameter name="command">ls</parameter></invoke>\n</tool_calls>'
      const leakTurn = (id: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        LLMEvent.textDelta({ id, text: leaked }),
        LLMEvent.textEnd({ id }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      // MAX_ATTEMPTS nudges, then a third leaking turn exhausts the budget.
      responses = [leakTurn("leak-1"), leakTurn("leak-2"), leakTurn("leak-3")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(ToolCallLeak.MAX_ATTEMPTS + 1)
      const context = yield* session.context(sessionID)
      const lastAssistant = context.findLast((message) => message.type === "assistant")
      expect(lastAssistant?.type === "assistant" ? lastAssistant.finish : undefined).toBe("error")
      expect(lastAssistant?.type === "assistant" ? lastAssistant.error?.message : undefined).toContain(
        "plain text",
      )
    }),
  )

  ;[
    { name: "inherits the parent turn model instead of the global default for subagents", override: false, resume: false },
    { name: "honors an explicit subagent model instead of the parent model", override: true, resume: false },
    { name: "repairs an unconfigured resumed subagent model", override: false, resume: true },
  ].forEach((test) =>
    it.effect(test.name, () =>
      Effect.gen(function* () {
        yield* setup
        const agent = yield* AgentV2.Service
        yield* agent.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (build) => {
            build.mode = "primary"
            if (test.override)
              build.model = { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") }
          }),
        )
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate this" }), resume: false })

        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
        })

        const resumed = test.resume ? yield* session.create({
          parentID: sessionID,
          agent: AgentV2.ID.make("build"),
          location: { directory: AbsolutePath.make("/project") },
        }) : undefined

        requests.length = 0
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "call-task",
              name: "task",
              input: { description: "child", prompt: "Say sub", subagent_type: "build", task_id: resumed?.id },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-sub" }),
            LLMEvent.textDelta({ id: "text-sub", text: "Sub result" }),
            LLMEvent.textEnd({ id: "text-sub" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ],
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-final" }),
            LLMEvent.textDelta({ id: "text-final", text: "Done" }),
            LLMEvent.textEnd({ id: "text-final" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ],
        ]

        yield* session.resume(sessionID)

        const context = yield* (yield* SessionStore.Service).context(sessionID)
        const tool = context
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((item) => item.type === "tool" && item.name === "task")
        expect(tool).toMatchObject({
          type: "tool",
          name: "task",
          state: { status: "completed", structured: { text: "Sub result" } },
        })
        expect(requests.map((request) => request.model)).toEqual([
          replacementModel,
          test.override ? model : replacementModel,
          replacementModel,
        ])
        const store = yield* SessionStore.Service
        const database = yield* Database.Service
        const child = yield* database.db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect((yield* store.get(child!.id))?.model).toMatchObject({
          id: test.override ? "fake-model" : "replacement",
          providerID: "fake",
        })
      }),
    ),
  )

  it.effect("reports a failed subagent as an error instead of empty output", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task",
            name: "task",
            input: { description: "child", prompt: "Say sub", subagent_type: "build" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "child boom" })],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "task")
      expect(tool).toMatchObject({
        type: "tool",
        name: "task",
        state: { status: "error", error: { type: "unknown", message: "Subagent failed: child boom" } },
      })
    }),
  )

  it.effect("interrupts a subagent that stops producing events", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task",
            name: "task",
            input: { description: "child", prompt: "Say sub", subagent_type: "build" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      // Hold the subagent's provider stream open so it emits nothing at all:
      // only the silence watchdog can end the parent's wait.
      const gate = yield* Deferred.make<void>()
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = gate
      while (requests.length < 2) yield* Effect.yieldNow

      const taskTool = (context: SessionMessage.Message[]) =>
        context
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((item) => item.type === "tool" && item.name === "task")
      const taskFailed = (context: SessionMessage.Message[]) =>
        context
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .some((item) => item.type === "tool" && item.name === "task" && item.state.status === "error")

      // Short of the deadline the subagent is still only slow.
      yield* TestClock.adjust("14 minutes")
      expect(taskTool(yield* session.context(sessionID))).toMatchObject({ state: { status: "running" } })

      yield* TestClock.adjust("2 minutes")
      let failed = taskFailed(yield* session.context(sessionID))
      for (let attempt = 0; attempt < 100 && !failed; attempt++) {
        yield* Effect.yieldNow
        failed = taskFailed(yield* session.context(sessionID))
      }
      expect(failed).toBe(true)
      expect(taskTool(yield* session.context(sessionID))).toMatchObject({
        type: "tool",
        name: "task",
        state: { status: "error", error: { message: expect.stringContaining("no output for 15 minutes") } },
      })

      streamGate = undefined
      yield* Fiber.interrupt(run)
    }),
  )

  it.effect("runs a workflow script that awaits two subagents in order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const db = (yield* Database.Service).db
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Orchestrate" }), resume: false })

      const textTurn = (id: string, text: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        LLMEvent.textDelta({ id, text }),
        LLMEvent.textEnd({ id }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-workflow",
            name: "workflow",
            input: {
              script: [
                'const first = await tools.workflow.agent({ prompt: "WORKFLOW FIRST", description: "first", agent: "build" })',
                'const second = await tools.workflow.agent({ prompt: "WORKFLOW SECOND", description: "second", agent: "build" })',
                "return first.text + '|' + second.text",
              ].join("\n"),
            },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        textTurn("text-first", "alpha"),
        textTurn("text-second", "beta"),
        textTurn("text-final", "Done"),
      ]

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "workflow")
      expect(tool).toMatchObject({
        type: "tool",
        name: "workflow",
        state: { status: "completed", structured: { text: "alpha|beta" } },
      })
      const children = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(2)
      const structured = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((item) =>
          item.type === "tool" && item.name === "workflow" && item.state.status === "completed"
            ? [item.state.structured]
            : [],
        )
      expect(structured[0]).toMatchObject({ sessions: expect.arrayContaining(children.map((child) => child.id)) })
    }),
  )

  it.effect("runs independent workflow steps together with Promise.all", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Orchestrate" }), resume: false })

      const gate = yield* Deferred.make<void>()
      const textTurn = (id: string, text: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        LLMEvent.textDelta({ id, text }),
        LLMEvent.textEnd({ id }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const gated = (id: string, text: string) =>
        Stream.unwrap(Deferred.await(gate).pipe(Effect.as(Stream.fromIterable(textTurn(id, text)))))
      const childRequests = () =>
        requests.filter((request) =>
          JSON.stringify(request.messages.filter((message) => message.role === "user")).includes("WORKFLOW PARALLEL"),
        )
      let parentTurns = 0
      responseFor = (request) => {
        const users = JSON.stringify(request.messages.filter((message) => message.role === "user"))
        if (users.includes("WORKFLOW PARALLEL A")) return gated("text-a", "alpha")
        if (users.includes("WORKFLOW PARALLEL B")) return gated("text-b", "beta")
        parentTurns += 1
        if (parentTurns === 1)
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "call-workflow-parallel",
              name: "workflow",
              input: {
                script: [
                  "const [first, second] = await Promise.all([",
                  '  tools.workflow.agent({ prompt: "WORKFLOW PARALLEL A", description: "a", agent: "build" }),',
                  '  tools.workflow.agent({ prompt: "WORKFLOW PARALLEL B", description: "b", agent: "build" }),',
                  "])",
                  "return [first.text, second.text].join('|')",
                ].join("\n"),
              },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
        return Stream.fromIterable(textTurn("text-final", "Done"))
      }

      requests.length = 0
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      // Both steps must be waiting on the provider at the same time: a sequential script
      // would still be blocked on the first child, so the second request would never arrive.
      for (let attempt = 0; attempt < 500 && childRequests().length < 2; attempt++) yield* Effect.yieldNow
      expect(childRequests()).toHaveLength(2)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(run)

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "workflow")
      expect(tool).toMatchObject({
        type: "tool",
        name: "workflow",
        state: { status: "completed", structured: { text: "alpha|beta" } },
      })
    }),
  )

  it.effect("fails the workflow when a step fails instead of returning an empty report", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Orchestrate" }), resume: false })

      let parentTurns = 0
      responseFor = (request) => {
        const users = JSON.stringify(request.messages.filter((message) => message.role === "user"))
        if (users.includes("WORKFLOW FAILING CHILD"))
          return Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "child boom" })])
        parentTurns += 1
        if (parentTurns === 1)
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "call-workflow-failing",
              name: "workflow",
              input: {
                script:
                  'const report = await tools.workflow.agent({ prompt: "WORKFLOW FAILING CHILD", description: "child", agent: "build" })\nreturn report.text',
              },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
        return Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-recovered" }),
          LLMEvent.textDelta({ id: "text-recovered", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-recovered" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      }

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "workflow")
      expect(tool).toMatchObject({
        type: "tool",
        name: "workflow",
        state: { status: "error", error: { message: expect.stringContaining("child boom") } },
      })
    }),
  )

  it.effect("delivers a message to a peer session and wakes it", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const runner = yield* SessionRunner.Service
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* insertSession(otherSessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ping peer" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-message",
            name: "send_message",
            // Resolved by slug, not by Session ID.
            input: { to: `@${otherSessionID}`, message: "hello peer" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-done" }),
          LLMEvent.textDelta({ id: "text-done", text: "Done" }),
          LLMEvent.textEnd({ id: "text-done" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const wakes: string[] = []
      yield* runner.run({ sessionID, force: true, wake: (id) => Effect.sync(() => wakes.push(id)) })

      expect(wakes).toEqual([otherSessionID])
      expect(
        permissionAsserts.some((entry) => entry.action === "message" && entry.resources.includes(otherSessionID)),
      ).toBe(true)
      expect(yield* SessionInput.hasPending(db, otherSessionID, "steer")).toBe(true)

      // Draining the target materializes the attributed message in its transcript.
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-ack" }),
          LLMEvent.textDelta({ id: "text-ack", text: "Ack" }),
          LLMEvent.textEnd({ id: "text-ack" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* runner.run({ sessionID: otherSessionID, force: true })

      const context = yield* session.context(otherSessionID)
      const first = context[0]
      expect(first).toMatchObject({ type: "user" })
      expect(first?.type === "user" ? first.text : "").toContain(`<message from session="${sessionID}">`)
      expect(first?.type === "user" ? first.text : "").toContain("hello peer")
    }),
  )

  for (const delivery of [undefined, "queue"] as const) {
    it.effect(`peer messages ${delivery ?? "default"} preserve tools and use the intended delivery boundary`, () =>
      Effect.gen(function* () {
        yield* setup
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) => editor.update(AgentV2.ID.make("build"), (agent) => { agent.mode = "primary" }))
        const runner = yield* SessionRunner.Service
        const session = yield* SessionV2.Service
        const database = yield* Database.Service
        yield* insertSession(otherSessionID)
        yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Target continues its long task" }), resume: false })
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Send useful feedback" }), resume: false })
        toolExecutionGate = yield* Deferred.make<void>()
        toolExecutionsStarted = yield* Deferred.make<void>()
        toolExecutionsReady = 1
        requests.length = 0
        responses = [
          [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "target-work", name: "echo", input: { text: "work in progress" } }), LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
          [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "sender-report", name: "send_message", input: { to: otherSessionID, message: "Important peer finding", ...(delivery ? { delivery } : {}) } }), LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
          [], [], [],
        ]
        const target = yield* runner.run({ sessionID: otherSessionID, force: true }).pipe(Effect.forkChild)
        yield* Deferred.await(toolExecutionsStarted)
        const wakes: string[] = []
        yield* runner.run({ sessionID, force: true, wake: (id) => Effect.sync(() => wakes.push(id)) })
        expect(wakes).toEqual([otherSessionID])
        expect(yield* SessionInput.hasPending(database.db, otherSessionID, delivery ?? "steer")).toBe(true)
        expect((yield* session.context(otherSessionID)).filter((message) => message.type === "user")).toHaveLength(1)
        expect(activeToolExecutions).toBe(1)
        yield* Deferred.succeed(toolExecutionGate, undefined)
        yield* Fiber.join(target)
        const recipientRequests = requests.filter((request) => JSON.stringify(request.messages).includes("Target continues its long task"))
        expect(recipientRequests).toHaveLength(delivery === "queue" ? 3 : 2)
        expect(JSON.stringify(recipientRequests[1]?.messages).includes("Important peer finding")).toBe(delivery !== "queue")
        expect(JSON.stringify(recipientRequests.at(-1)?.messages)).toContain("Important peer finding")
        expect(activeToolExecutions).toBe(0)
      }),
    )
  }

  it.effect("fails clearly when a message target is missing", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const runner = yield* SessionRunner.Service
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ping nobody" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "send_message", input: { to: "ses_missing", message: "hi" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* runner.run({ sessionID, force: true })

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "send_message")
      expect(tool).toMatchObject({
        type: "tool",
        name: "send_message",
        state: { status: "error", error: { type: "unknown", message: "Unknown session: ses_missing" } },
      })
    }),
  )

  it.effect("refuses to overflow a peer session inbox", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const runner = yield* SessionRunner.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* insertSession(otherSessionID)
      for (let index = 0; index < SendMessageTool.MAX_INBOUND_QUEUE; index++) {
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: otherSessionID,
          prompt: Prompt.make({ text: `filler ${index}` }),
          delivery: index % 2 === 0 ? "queue" : "steer",
        })
      }
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ping full inbox" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-overflow",
            name: "send_message",
            input: { to: otherSessionID, message: "one too many" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* runner.run({ sessionID, force: true })

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "send_message")
      expect(tool).toMatchObject({ type: "tool", name: "send_message", state: { status: "error" } })
      expect(JSON.stringify(tool)).toContain("inbox is full")
    }),
  )

  it.effect("lists sibling sessions for discovery", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const runner = yield* SessionRunner.Service
      const session = yield* SessionV2.Service
      yield* insertSession(otherSessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Who is around?" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-list", name: "list_sessions", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* runner.run({ sessionID, force: true })

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "list_sessions")
      expect(tool).toMatchObject({ type: "tool", name: "list_sessions", state: { status: "completed" } })
      expect(JSON.stringify(tool)).toContain(String(otherSessionID))
      expect(JSON.stringify(tool)).toContain(`@${otherSessionID}`)
    }),
  )

  it.effect("raises a notification the human can be pulled back by", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const runner = yield* SessionRunner.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Wake me when it lands" }), resume: false })
      const live = yield* events
        .subscribe(SessionEvent.Notified)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-notify",
            name: "push_notification",
            input: { title: "Release build", message: "The release build passed" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* runner.run({ sessionID, force: true })

      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((item) => item.type === "tool" && item.name === "push_notification")
      expect(tool).toMatchObject({ type: "tool", name: "push_notification", state: { status: "completed" } })

      const notified = Array.from(yield* Fiber.join(live))
      expect(notified).toHaveLength(1)
      expect(notified[0]!.data).toMatchObject({
        sessionID,
        title: "Release build",
        message: "The release build passed",
      })
      // The hint is a live signal, not session state: a client that was not
      // connected when it fired has nothing to replay.
      const { db } = yield* Database.Service
      const stored = yield* db.select({ type: EventTable.type }).from(EventTable).all().pipe(Effect.orDie)
      expect(stored.filter((row) => row.type.includes("notified"))).toHaveLength(0)
    }),
  )

  it.effect("keeps continuing while todos stay open, then stops on no progress", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "Do the thing", status: "in_progress", priority: "high" }],
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Work" }), resume: false })

      requests.length = 0
      responses = undefined
      response = fragmentFixture("text", "text-loop", ["ok"]).completeEvents
      yield* session.resume(sessionID)

      // Two unchanged todo signatures trigger the stall guard and stop the loop.
      expect(requests.length).toBeGreaterThan(1)
      expect(requests.length).toBeLessThanOrEqual(5)
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
        [persona, `Initial context\n\n${todoBaseline}`, planIntent, language],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("promotes durable queued input after interruption without an explicit resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      // Interrupting hands the queued input to a successor drain on its own, so
      // the queued text must reach the next request without an explicit resume.
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* session.wait(sessionID)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("promotes durable steering input after interruption without an explicit resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      // Interrupting hands the steering input to a successor drain on its own, so
      // the steering text must reach the next request without an explicit resume.
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* session.wait(sessionID)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: "Tool execution outcome unknown: the process stopped while it was running.",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("reports a tool the prior process never dispatched as not executed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover undispatched tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      // Input streamed, but no `Tool.Called`: the runner never dispatched it.
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-undispatched",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-undispatched",
        text: '{"text":"never ran"}',
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover undispatched tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-undispatched",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message:
                    "Tool was not executed: the process stopped before it was dispatched, so it is safe to retry.",
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("adds session correlation headers to model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run correlated request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
      })
    }),
  )

  it.effect("sends the prompt cache key as the session-id header to OpenAI", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: "gpt-6.1-sol", provider: "openai", route: OpenAIChat.route })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run cached request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers?.["session-id"]).toBe(sessionID)
      expect(requests[0]?.providerOptions?.openai?.promptCacheKey).toBe(requests[0]?.http?.headers?.["session-id"])
    }),
  )

  it.effect("adds the parent session header to child model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const parentID = SessionV2.ID.make("ses_runner_parent")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ parent_id: parentID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run child request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers?.["x-parent-session-id"]).toBe(parentID)
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.live("kills the spawned process group when the run is interrupted", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* setup
      const session = yield* SessionV2.Service
      yield* Effect.promise(() => fs.rm(spawnPidFile, { force: true }))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run a long command" }), resume: false })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-spawn",
            name: "spawn",
            input: { command: `echo $$ > ${spawnPidFile}; exec sleep 300` },
          }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const pid = yield* waitForPid(spawnPidFile)
      expect(processAlive(pid)).toBe(true)
      expect(Array.from(yield* session.active)).toEqual([sessionID])

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      // Interrupting the run must reach the OS process, not just the fiber.
      expect(yield* waitForProcessExit(pid)).toBe(true)
      expect(Array.from(yield* session.active)).toEqual([])

      responseStream = undefined
      response = []
      requests.length = 0
    }).pipe(Effect.provide(spawnTool)),
  )

  it.live("stops a subagent's spawned process group when the parent run is interrupted", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* setup
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* Effect.promise(() => fs.rm(spawnPidFile, { force: true }))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate a long command" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task",
            name: "task",
            input: { description: "run long", prompt: "run a long command", subagent_type: "build" },
          }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-spawn",
            name: "spawn",
            input: { command: `echo $$ > ${spawnPidFile}; exec sleep 300` },
          }),
        ],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const pid = yield* waitForPid(spawnPidFile)
      expect(processAlive(pid)).toBe(true)

      // The command must belong to the subagent's own Session. Task runs its
      // child through the runner directly, so the coordinator only ever tracks
      // the parent; checking the child context keeps this test from silently
      // re-checking the parent's own tool execution.
      const { db } = yield* Database.Service
      const children = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      const childContext = yield* (yield* SessionStore.Service).context(children[0]!.id)
      expect(
        childContext
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((item) => item.type === "tool" && item.name === "spawn"),
      ).toMatchObject({ type: "tool", name: "spawn" })
      expect(Array.from(yield* session.active)).toEqual([sessionID])

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      // A parent interrupt must reach the subagent's OS work and leave no
      // orphan drain behind.
      expect(yield* waitForProcessExit(pid)).toBe(true)
      expect(Array.from(yield* session.active)).toEqual([])

      responses = undefined
      response = []
      requests.length = 0
    }).pipe(Effect.provide(spawnTool)),
  )

  // The command shape a real turn uses: a compound shell line whose shell stays
  // alive waiting on a foreground child, with output redirected to a file. The
  // test above covers `exec`, which replaces the shell and leaves one process.
  it.live("stops a subagent's compound command process group when the parent run is interrupted", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* setup
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      const pidFile = `${os.tmpdir()}/miao-runner-compound-${process.pid}.pid`
      const doneFile = `${os.tmpdir()}/miao-runner-compound-${process.pid}.done`
      yield* Effect.promise(() => fs.rm(pidFile, { force: true }))
      yield* Effect.promise(() => fs.rm(doneFile, { force: true }))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate a long command" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task",
            name: "task",
            input: { description: "run long", prompt: "run a long command", subagent_type: "build" },
          }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-spawn",
            name: "spawn",
            input: { command: `echo $$ > ${pidFile}; sleep 297.123; echo done > ${doneFile}` },
          }),
        ],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const pid = yield* waitForPid(pidFile)
      expect(processAlive(pid)).toBe(true)
      const child = yield* waitForChild(pid)
      expect(processAlive(child)).toBe(true)

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      expect(yield* waitForProcessExit(pid)).toBe(true)
      expect(yield* waitForProcessExit(child)).toBe(true)
      // A command that reached its last statement ran to completion; the turn
      // was interrupted long before it could.
      expect(yield* Effect.promise(() => fs.readFile(doneFile, "utf8").catch(() => ""))).toBe("")

      responses = undefined
      response = []
      requests.length = 0
    }).pipe(Effect.provide(spawnTool)),
  )

  // Same guarantee, but through the shipped bash tool instead of the test's spawn
  // tool: that is the path a real turn takes, and the only one whose permission
  // assertions, workdir handling, and timeout are the production ones.
  itWithBash.live("stops a subagent's shipped bash process group when the parent run is interrupted", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* setup
      // The runner interrupts any turn whose Session Location differs from the bound
      // Location, so this session has to live in the real directory the harness binds.
      yield* (yield* Database.Service).db
        .update(SessionTable)
        .set({ directory: bashLocation })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* (yield* AgentV2.Service).transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (build) => {
          build.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      const pidFile = `${os.tmpdir()}/miao-runner-bash-${process.pid}.pid`
      const doneFile = `${os.tmpdir()}/miao-runner-bash-${process.pid}.done`
      yield* Effect.promise(() => fs.rm(pidFile, { force: true }))
      yield* Effect.promise(() => fs.rm(doneFile, { force: true }))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Delegate a long command" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task",
            name: "task",
            input: { description: "run long", prompt: "run a long command", subagent_type: "build" },
          }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-bash",
            name: "bash",
            input: {
              command: `echo $$ > ${pidFile}; sleep 297.123; echo done > ${doneFile}`,
              // Mirrors the incident: a ten minute budget on the tool, far longer
              // than the turn lives.
              timeout: 600_000,
            },
          }),
        ],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const pid = yield* waitForPid(pidFile)
      expect(processAlive(pid)).toBe(true)
      const child = yield* waitForChild(pid)
      expect(processAlive(child)).toBe(true)

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      expect(yield* waitForProcessExit(pid)).toBe(true)
      expect(yield* waitForProcessExit(child)).toBe(true)
      expect(yield* waitForProcessExit(child)).toBe(true)
      // Reaching the last statement means the command outlived the turn; the
      // interrupt has to land before it does.
      expect(yield* Effect.promise(() => fs.readFile(doneFile, "utf8").catch(() => ""))).toBe("")

      responses = undefined
      response = []
      requests.length = 0
    }),
    60_000,
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  ;["stream-read", "connection-closed", "connection-failed", "Timeout", "tls-handshake"].forEach((kind) => {
    it.effect(`retries ${kind} before its first event`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Survive a dropped stream" }), resume: false })
        // A retry resubscribes the same provider stream, which re-sends the HTTP
        // request; the first subscription drops before any event arrives.
        let attempts = 0
        responseStream = Stream.unwrap(
          Effect.sync(() =>
            attempts++ === 0
              ? Stream.fail(
                  new LLMError({
                    module: "test",
                    method: "stream",
                    reason: new TransportReason({ message: "connection reset", kind }),
                  }),
                )
              : Stream.fromIterable(fragmentFixture("text", "text-after-drop", ["Recovered"]).completeEvents),
          ),
        )

        const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
        while (attempts < 2) yield* TestClock.adjust("1 second")
        yield* Fiber.join(resumed)

        expect(attempts).toBe(2)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Survive a dropped stream" },
          { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
        ])
        const { db } = yield* Database.Service
        const retried = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
          .all()
          .pipe(Effect.orDie)
        expect(retried.map((row) => row.data)).toMatchObject([
          { sessionID, attempt: 1, error: { message: "test.stream: connection reset", isRetryable: true } },
        ])
      }),
    )
  })

  it.effect("stops repetitive output without retrying or replaying completed tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Work once" }), resume: false })
      const before = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "before-loop", name: "echo", input: { text: "already completed" } }),
        LLMEvent.textStart({ id: "loop" }),
        ...Array.from({ length: 80 }, () => LLMEvent.textDelta({ id: "loop", text: "Emit.\nedit.\n" })),
        LLMEvent.toolCall({ id: "after-loop", name: "echo", input: { text: "must not execute" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      requests.length = 0
      const error = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).toContain("Stopped repetitive text output")
      expect(requests).toHaveLength(1)
      expect(executions.slice(before)).toEqual(["already completed"])
      const recorded = (yield* session.context(sessionID)).at(-1)
      expect(recorded).toMatchObject({ type: "assistant", finish: "error" })
      if (recorded?.type !== "assistant") throw new Error("Missing assistant record")
      expect(recorded.content.some((part) => part.type === "text" && part.text.includes("Emit."))).toBe(true)
      expect(recorded.content).toContainEqual(
        expect.objectContaining({
          type: "tool",
          id: "before-loop",
          state: expect.objectContaining({ status: "completed" }),
        }),
      )

      response = fragmentFixture("text", "recovered", ["Continuing without repeating work."]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue safely" }), resume: false })
      yield* session.resume(sessionID)
      expect(executions.slice(before)).toEqual(["already completed"])
      const history = requests.at(-1)?.messages ?? []
      expect(
        history.some((message) =>
          message.content.some((part) => part.type === "text" && part.text === SessionOutputGuard.NEUTRALIZED),
        ),
      ).toBe(true)
      expect(
        history.some((message) =>
          message.content.some((part) => part.type === "text" && part.text.includes("Emit.\nedit.")),
        ),
      ).toBe(false)
      expect(
        history.some((message) =>
          message.content.some((part) => part.type === "tool-call" && part.id === "before-loop"),
        ),
      ).toBe(true)
      expect(
        (yield* session.context(sessionID)).some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Emit.")),
        ),
      ).toBe(true)
    }),
  )

  it.effect("does not replay a connection failure after publishing assistant text", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Keep partial output" }), resume: false })
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: new TransportReason({ message: "connection reset", kind: "connection-closed" }),
      })
      responseStream = Stream.concat(
        Stream.fromIterable(fragmentFixture("text", "partial-connection", ["Partial"]).partialEvents),
        Stream.fail(failure),
      )
      requests.length = 0
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        content: [{ type: "text", text: "Partial" }],
      })
    }),
  )

  it.effect("keeps the HTTP status visible in terminal assistant errors", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      streamFailure = new LLMError({
        module: "RequestExecutor", method: "execute",
        reason: new InvalidRequestReason({
          message: "Invalid model request",
          http: new HttpContext({
            request: new HttpRequestDetails({ method: "POST", url: "https://api.example/v1/chat/completions", headers: {} }),
            response: new HttpResponseDetails({ status: 400, headers: {} }),
          }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Show the model error" }), resume: false })
      yield* session.resume(sessionID).pipe(Effect.flip)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant", error: { message: "API Error: 400 · Invalid model request" },
      })
    }),
  )

  it.effect("announces an unavailable model when catalog resolution actually retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const failure = new SessionRunnerModel.ModelUnavailableError({
        providerID: ProviderV2.ID.make("fake"),
        modelID: ModelV2.ID.make("fake-model"),
      })
      const calls = { count: 0 }
      modelResolveHook = Effect.suspend(() => (++calls.count === 1 ? Effect.fail(failure) : Effect.void))
      response = fragmentFixture("text", "catalog-recovered", ["Recovered catalog"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Wait for catalog recovery" }), resume: false })
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
      while (calls.count < 2) yield* TestClock.adjust("1 second")
      yield* Fiber.join(resumed)
      const notices = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
        .all()
        .pipe(Effect.orDie)
      expect(notices.map((notice) => notice.data)).toMatchObject([
        { sessionID, attempt: 1, error: { message: failure.message, isRetryable: true } },
      ])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Recovered catalog" }],
      })
    }),
  )

  it.effect("records why a throttled provider attempt was retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Survive a rate limit" }), resume: false })
      // A routed 429 carries its status on the captured response rather than on
      // the reason, and the vendor's request id is the only handle support has on
      // the request that was throttled, so both have to survive into the event.
      let attempts = 0
      responseStream = Stream.unwrap(
        Effect.sync(() =>
          attempts++ === 0
            ? Stream.fail(
                new LLMError({
                  module: "RequestExecutor",
                  method: "execute",
                  reason: new RateLimitReason({
                    message: 'Provider request failed with HTTP 429: {"code":"429003"}',
                    retryAfterMs: 1_000,
                    rateLimit: new HttpRateLimitDetails({
                      retryAfterMs: 1_000,
                      limit: { tokens: "3000000" },
                      remaining: { tokens: "0" },
                    }),
                    http: new HttpContext({
                      request: new HttpRequestDetails({
                        method: "POST",
                        url: "https://api.example/v1/chat/completions",
                        headers: { "content-type": "application/json" },
                      }),
                      response: new HttpResponseDetails({ status: 429, headers: { "retry-after": "1" } }),
                      body: '{"code":"429003","message":"TPM limit 3000000 exceeded"}',
                      requestId: "3ad25122-8353-4ca1-bc7f-575dd63f5e7f",
                    }),
                  }),
                }),
              )
            : Stream.fromIterable(fragmentFixture("text", "text-after-limit", ["Recovered"]).completeEvents),
        ),
      )

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
      while (attempts < 2) yield* TestClock.adjust("1 second")
      yield* Fiber.join(resumed)

      expect(attempts).toBe(2)
      const { db } = yield* Database.Service
      const retried = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
        .all()
        .pipe(Effect.orDie)
      expect(retried.map((row) => row.data)).toMatchObject([
        {
          sessionID,
          attempt: 1,
          error: {
            statusCode: 429,
            isRetryable: true,
            responseHeaders: { "retry-after": "1" },
            responseBody: '{"code":"429003","message":"TPM limit 3000000 exceeded"}',
            metadata: {
              requestId: "3ad25122-8353-4ca1-bc7f-575dd63f5e7f",
              retryAfterMs: "1000",
              "rateLimit.limit.tokens": "3000000",
              "rateLimit.remaining.tokens": "0",
            },
          },
        },
      ])
    }),
  )

  it.effect("settles a step with the same model its start recorded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle a step" }), resume: false })
      responseStream = Stream.fromIterable(fragmentFixture("text", "text-settled", ["Settled"]).completeEvents)

      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const byType = (type: string, version: number) =>
        db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(type, version)))
          .all()
          .pipe(Effect.orDie)
      const started = yield* byType(SessionEvent.Step.Started.type, 1)
      const ended = yield* byType(SessionEvent.Step.Ended.type, 2)

      expect(ended).toHaveLength(1)
      expect(ended.map((row) => row.data.model)).toEqual(started.map((row) => row.data.model))
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )

  it.effect("fails a turn whose stream ends without a completion frame", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
      ]
      yield* session.resume(sessionID)

      const assistant = (yield* (yield* SessionStore.Service).context(sessionID)).findLast(
        (message) => message.type === "assistant",
      )
      expect(assistant?.type === "assistant" ? assistant.error : undefined).toBeDefined()
    }),
  )

  it.effect("refuses to drain a session whose history is still legacy-only", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(MessageTable)
        .values({
          id: "msg_legacy_runner",
          session_id: sessionID,
          time_created: 1,
          time_updated: 1,
          data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "fake", modelID: "fake-model" } },
        } as never)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: "prt_legacy_runner",
          message_id: "msg_legacy_runner",
          session_id: sessionID,
          time_created: 1,
          time_updated: 1,
          data: { type: "text", text: "legacy" },
        } as never)
        .run()
        .pipe(Effect.orDie)

      const runner = yield* SessionRunner.Service
      requests.length = 0
      const error = yield* runner.run({ sessionID, force: true }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LegacyNotMigratedError)
      expect(requests).toHaveLength(0)
    }),
  )

  describe("title generation", () => {
    const defaultTitle = "New session - 2026-10-02T00:00:00.000Z"
    const setTitle = (title: string, parentID?: SessionV2.ID) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ title, parent_id: parentID ?? null })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      })
    const titleAgent = AgentV2.Service.pipe(
      Effect.flatMap((agents) =>
        agents.transform((editor) =>
          editor.update(AgentV2.ID.make("title"), (agent) => {
            agent.mode = "primary"
            agent.hidden = true
            agent.system = TITLE_SYSTEM
          }),
        ),
      ),
    )
    const titleRequests = () =>
      requests.filter((request) => request.system.some((part) => part.text === TITLE_SYSTEM))
    // The title fiber runs beside the drain; give it scheduler turns to finish.
    const settle = Effect.gen(function* () {
      for (let index = 0; index < 200; index++) yield* Effect.yieldNow
    })
    const currentTitle = SessionV2.Service.pipe(
      Effect.flatMap((sessions) => sessions.get(sessionID)),
      Effect.map((session) => session.title),
    )

    it.effect("titles a root Session with a placeholder title after its first prompt", () =>
      Effect.gen(function* () {
        yield* setup
        yield* titleAgent
        yield* setTitle(defaultTitle)
        const session = yield* SessionV2.Service
        requests.length = 0
        response = fragmentFixture("text", "text-main", ["Answer"]).completeEvents
        titleResponse = fragmentFixture("text", "text-title", ["<think>hmm</think>\nFix the login bug\nextra"]).completeEvents
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Login fails on submit" }), resume: false })
        yield* session.resume(sessionID)
        yield* settle

        expect(titleRequests()).toHaveLength(1)
        expect(userTexts(titleRequests()[0])).toEqual([
          "Generate a title for this conversation:\n",
          "Login fails on submit",
        ])
        expect(yield* currentTitle).toBe("Fix the login bug")

        // A second prompt never retitles.
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Another" }), resume: false })
        yield* session.resume(sessionID)
        yield* settle
        expect(titleRequests()).toHaveLength(1)
      }),
    )

    it.effect("keeps manual titles, skips child Sessions, and survives title failures", () =>
      Effect.gen(function* () {
        yield* setup
        yield* titleAgent
        const session = yield* SessionV2.Service
        response = fragmentFixture("text", "text-title-skip", ["Generated"]).completeEvents
        titleResponse = response

        yield* setTitle("My own title")
        requests.length = 0
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(sessionID)
        yield* settle
        expect(titleRequests()).toHaveLength(0)
        expect(yield* currentTitle).toBe("My own title")

        yield* insertSession(otherSessionID)
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ title: defaultTitle, parent_id: otherSessionID })
          .where(eq(SessionTable.id, otherSessionID))
          .run()
          .pipe(Effect.orDie)
        yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Child" }), resume: false })
        yield* session.resume(otherSessionID)
        yield* settle
        expect(titleRequests()).toHaveLength(0)
      }),
    )

    it.effect("leaves the Session usable when the title model fails", () =>
      Effect.gen(function* () {
        yield* setup
        yield* titleAgent
        yield* setTitle(defaultTitle)
        const session = yield* SessionV2.Service
        requests.length = 0
        response = fragmentFixture("text", "text-main", ["Answer"]).completeEvents
        titleResponse = [LLMEvent.providerError({ message: "title model down" })]
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Question" }), resume: false })
        yield* session.resume(sessionID)
        yield* settle

        expect(titleRequests()).toHaveLength(1)
        expect(yield* currentTitle).toBe(defaultTitle)
        expect((yield* session.messages({ sessionID })).some((message) => message.type === "assistant")).toBe(true)
      }),
    )
  })

  describe("session failure events", () => {
    const collectFailures = Effect.gen(function* () {
      const events = yield* EventV2.Service
      const failures: SessionEvent.Failed["data"][] = []
      yield* events.subscribe(SessionEvent.Failed).pipe(
        Stream.runForEach((event) => Effect.sync(() => failures.push(event.data))),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      return failures
    })

    it.effect("reports a drain that fails before any provider step", () =>
      Effect.gen(function* () {
        yield* setup
        const failures = yield* collectFailures
        const { db } = yield* Database.Service
        yield* db
          .insert(MessageTable)
          .values({
            id: "msg_legacy_failure",
            session_id: sessionID,
            time_created: 1,
            time_updated: 1,
            data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "fake", modelID: "fake-model" } },
          } as never)
          .run()
          .pipe(Effect.orDie)

        const runner = yield* SessionRunner.Service
        yield* runner.run({ sessionID, force: true }).pipe(Effect.flip)
        yield* Effect.yieldNow

        expect(failures).toMatchObject([
          { sessionID, name: "Session.LegacyNotMigratedError", error: { type: "unknown", message: expect.any(String) } },
        ])
      }),
    )

    it.effect("leaves provider failures to step.failed", () =>
      Effect.gen(function* () {
        yield* setup
        const failures = yield* collectFailures
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail at the provider" }), resume: false })
        streamFailure = new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({ message: "bad request" }),
        })

        yield* session.resume(sessionID).pipe(Effect.exit)
        yield* Effect.yieldNow

        expect(failures).toEqual([])
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user" },
          { type: "assistant", finish: "error", error: { message: "bad request" } },
        ])
      }),
    )
  })
})
