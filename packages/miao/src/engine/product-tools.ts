import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentV2 } from "@miao/core/agent"
import { BackgroundJob } from "@miao/core/background-job"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { PermissionV2 } from "@miao/core/permission"
import { PeerTools } from "@miao/core/session/peer-tools"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionMessage } from "@miao/core/session/message"
import { SessionOwnership } from "@miao/core/session/ownership"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionStore } from "@miao/core/session/store"
import { SessionTodo } from "@miao/core/session/todo"
import { Tool } from "@miao/core/tool/tool"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { PushNotificationTool } from "@miao/core/tool/push-notification"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolFailure, type ToolCall } from "@miao/llm"
import type { Location } from "@miao/schema/location"
import { Effect, Option, Schema } from "effect"
import { EngineError, type EngineOptions } from "./client"
import type { EngineClient } from "./client"
import { PluginTools } from "./plugin-tools"
import type { EngineSession } from "./session"
import { readTranscriptEntries } from "./transcript"

/**
 * Host side of the engine's product-tool reverse bridge: a manifest of
 * definitions the engine may advertise, plus the executor that settles each
 * reverse-dispatched call against the Session it names.
 *
 * Only tools whose host implementation works for an engine-owned Session are
 * advertised. Product tools with no native capability yet stay absent rather
 * than failing at call time.
 */

export interface Owner {
  readonly client: Pick<EngineClient, "request">
  readonly session: Pick<EngineSession, "promptProduct">
}

export interface Router {
  readonly get: (input: {
    readonly storage: string
    readonly engineID: string
    readonly location: Location.Ref
    readonly refreshContext?: boolean
  }) => Effect.Effect<Owner, unknown>
}

const Snapshot = Schema.Struct({
  title: Schema.optional(Schema.String),
  updated_at_ms: Schema.optional(Schema.Number),
  active_run: Schema.optional(Schema.NullOr(Schema.String)),
  pending: Schema.optional(Schema.Array(Schema.Unknown)),
  state: Schema.optional(
    Schema.Struct({
      todos: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            value: Schema.Struct({
              todos: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
            }),
          }),
        ),
      ),
      goal: Schema.optional(
        Schema.NullOr(Schema.Struct({ value: Schema.Struct({ objective: Schema.String, status: Schema.String }) })),
      ),
    }),
  ),
})

const nativeOwner = (router: Router, placement: { storage: string; location: Location.Ref }, sessionID: string) =>
  Effect.gen(function* () {
    const owner = yield* router.get({
      storage: placement.storage,
      engineID: placement.storage,
      location: placement.location,
    })
    return yield* Effect.tryPromise({
      try: () => owner.client.request("snapshot", { session_id: sessionID }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  })

export const prepare = Effect.fn("Engine.productTools")(function* (
  configuration: Omit<EngineOptions, "db" | "workspace">,
  router: Router,
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.productToolsFile) return options
  const db = (yield* Database.Service).db
  const store = yield* SessionStore.Service
  const permission = yield* PermissionV2.Service
  const events = yield* EventV2.Service
  const todos = yield* SessionTodo.Service
  const ownership = yield* SessionOwnership.Service
  // The engine layer is composed beside the server's process-global execution
  // router, so this is usually absent. Admission remains durable either way;
  // only an explicit cross-host wake is best-effort.
  const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
  const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
  const registry = Option.getOrUndefined(yield* Effect.serviceOption(ToolRegistry.Service))
  const plugins = Option.getOrUndefined(yield* Effect.serviceOption(ToolPlugins.Service))
  const agents = Option.getOrUndefined(yield* Effect.serviceOption(AgentV2.Service))
  const product = PeerTools.makePeers({ db, events, store, ownership, todos, execution, jobs, wake: execution?.wake })

  const placement = (sessionID: SessionSchema.ID) => SessionEnginePlacement.find(db, sessionID)

  const peers: PeerTools.Peers = {
    get: (sessionID) => store.get(sessionID),
    list: (sender) => PeerTools.listPeerRows({ db, sender }),
    resolve: (sender, to) => product.resolve(sender, to),
    work: (sessionID) =>
      Effect.gen(function* () {
        const found = yield* placement(sessionID)
        if (found?.engine !== "rust") return yield* product.work(sessionID)
        const snapshot = Schema.decodeUnknownSync(Snapshot)(yield* nativeOwner(router, found, sessionID))
        const list = snapshot.state?.todos?.value.todos ?? []
        const goal = snapshot.state?.goal?.value
        const unfinished =
          list.some((todo) => todo.status !== "completed" && todo.status !== "cancelled") ||
          (goal !== undefined && goal.status !== "done")
        const busy = (snapshot.active_run ?? null) !== null || (snapshot.pending?.length ?? 0) > 0
        return {
          execution: busy ? ("busy" as const) : ("idle" as const),
          task: unfinished
            ? ("unfinished" as const)
            : list.length > 0 || goal !== undefined
              ? ("completed" as const)
              : ("unknown" as const),
          backgroundJobs: 0,
          objective:
            goal?.objective ?? list.find((todo) => todo.status !== "completed" && todo.status !== "cancelled")?.content,
          active: busy || unfinished,
          ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
          ...(snapshot.updated_at_ms === undefined ? {} : { lastActivity: snapshot.updated_at_ms }),
        }
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            execution: "unknown" as const,
            task: "unknown" as const,
            backgroundJobs: 0,
            active: false,
          }),
        ),
      ),
    pending: (sessionID) =>
      Effect.gen(function* () {
        const found = yield* placement(sessionID)
        if (found?.engine !== "rust") return yield* product.pending(sessionID)
        const snapshot = Schema.decodeUnknownSync(Snapshot)(yield* nativeOwner(router, found, sessionID))
        return snapshot.pending?.length ?? 0
      }),
    admit: (input) =>
      Effect.gen(function* () {
        const found = yield* placement(input.sessionID)
        if (found?.engine !== "rust") return yield* product.admit(input)
        const owner = yield* router.get({
          storage: found.storage,
          engineID: found.storage,
          location: found.location,
          refreshContext: true,
        })
        yield* Effect.tryPromise({
          try: () =>
            owner.session.promptProduct({
              sessionID: input.sessionID,
              id: input.id,
              prompt: input.prompt,
              delivery: input.delivery,
              resume: input.resume,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.asVoid)
      }),
    history: (sessionID) =>
      Effect.gen(function* () {
        const found = yield* placement(sessionID)
        if (found?.engine !== "rust") return yield* product.history(sessionID)
        const owner = yield* router.get({
          storage: found.storage,
          engineID: found.storage,
          location: found.location,
        })
        return yield* Effect.tryPromise({
          try: () =>
            readTranscriptEntries({
              sessionID,
              engineID: found.storage,
              location: found.location,
              selected: false,
              request: (method, params) => owner.client.request(method, params),
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
      }),
    wake: (sessionID) => (execution ? execution.wake(sessionID) : Effect.void),
  }

  const make = (sessionID: SessionSchema.ID): Readonly<Record<string, Tool.AnyTool>> => ({
    ...PeerTools.make({ sessionID, permission, peers }),
    push_notification: PushNotificationTool.make((request) =>
      PushNotificationTool.publish(events, sessionID, request).pipe(
        Effect.mapError(() => new ToolFailure({ message: "Unable to raise the notification" })),
      ),
    ),
    ...(registry && plugins && agents ? PluginTools.make({ registry, plugins, agents, store }) : {}),
  })

  const manifest = make(SessionSchema.ID.make("ses_product_tools"))
  const tools = Object.entries(manifest).map(([name, tool]) => {
    const definition = Tool.definition(name, tool)
    return { name: definition.name, description: definition.description, input_schema: definition.inputSchema }
  })

  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-product-tools-")),
      catch: () => new EngineError("engine_product_tools_io", "could not create native product-tools directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "product-tools.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, JSON.stringify({ tools }), { mode: 0o600 }),
    catch: () => new EngineError("engine_product_tools_io", "could not write native product-tools manifest"),
  })
  options.productToolsFile = file
  options.onProductTool = async (call) => {
    const sessionID = SessionSchema.ID.make(call.sessionID)
    return Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* store.get(sessionID)
        const tool = make(sessionID)[call.name]
        if (!tool) return yield* new ToolFailure({ message: `Unknown product tool: ${call.name}` })
        const toolCall: ToolCall = {
          type: "tool-call",
          id: call.callID,
          name: call.name,
          input: call.input,
        }
        const output = yield* Tool.settle(tool, toolCall, {
          sessionID,
          agent: session?.agent ?? AgentV2.defaultID,
          assistantMessageID: SessionMessage.ID.create(),
          toolCallID: call.callID,
        })
        const text = output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        return text.length > 0 ? text : output.structured
      }),
    )
  }
  return options
})

export * as ProductTools from "./product-tools"
