import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentV2 } from "@miao/core/agent"
import { BackgroundJob } from "@miao/core/background-job"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { PermissionV2 } from "@miao/core/permission"
import { ProjectV2 } from "@miao/core/project"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { SessionMoveCoordinator } from "@miao/core/session/move-coordinator"
import { PeerTools } from "@miao/core/session/peer-tools"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionMessage } from "@miao/core/session/message"
import { Prompt } from "@miao/core/session/prompt"
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
import { AbsolutePath } from "@miao/core/schema"
import { Effect, Option, Schema } from "effect"
import { EngineError, type EngineOptions } from "./client"
import type { EngineClient } from "./client"
import { moveEngine } from "./transfer"
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
  const database = yield* Database.Service
  const db = database.db
  // Engine-owned worktree moves land in the same per-Location storage layout
  // the server derives for newborn native Sessions.
  const storageRoot = process.env.MIAO_ENGINE_STORAGE
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
  const worktrees = Option.getOrUndefined(yield* Effect.serviceOption(ProjectWorktree.Service))
  const projects = Option.getOrUndefined(yield* Effect.serviceOption(ProjectV2.Service))
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

  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined

  const destinationStorage = (location: Location.Ref) => {
    if (!storageRoot) return undefined
    return AbsolutePath.make(
      path.resolve(storageRoot, `${new Bun.CryptoHasher("sha256").update(JSON.stringify(location)).digest("hex")}.db`),
    )
  }

  const makeWorktreeTools = (
    sessionID: SessionSchema.ID,
  ): Readonly<Record<string, Tool.AnyTool>> => {
    if (!worktrees || !projects || !storageRoot) return {}
    const worktreeService = worktrees
    const projectService = projects
    const root = storageRoot
    const asMoveFailure = (fallback: string) => (error: unknown) =>
      new ToolFailure({
        message:
          typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
            ? error.message
            : fallback,
      })
    const owner = (found: { storage: string; location: Location.Ref }) =>
      router.get({ storage: found.storage, engineID: found.storage, location: found.location })
    const destinationStorage = (location: Location.Ref) =>
      AbsolutePath.make(
        path.resolve(root, `${new Bun.CryptoHasher("sha256").update(JSON.stringify(location)).digest("hex")}.db`),
      )
    const placementRootFor = (directory: string) =>
      Effect.gen(function* () {
        const project = yield* projectService.resolve(AbsolutePath.make(directory))
        if (!project.vcs) return undefined
        return {
          projectID: project.id,
          worktree: project.directory,
          checkout: AbsolutePath.make(path.dirname(project.vcs.store)),
        }
      })
    const move = (found: { storage: string; location: Location.Ref }, destination: Location.Ref) =>
      Effect.gen(function* () {
        const source = yield* owner(found)
        const destinationPath = destinationStorage(destination)
        const destinationOwner = yield* router.get({
          storage: destinationPath,
          engineID: destinationPath,
          location: destination,
        })
        const engines = moveEngine(source.client)
        const destinationEngines = moveEngine(destinationOwner.client)
        yield* SessionMoveCoordinator.moveRust({
          database: db,
          id: crypto.randomUUID(),
          sessionID,
          source: { engine: "rust", storage: found.storage, location: found.location },
          target: { engine: "rust", storage: destinationPath, location: destination },
          bundleFile: AbsolutePath.make(path.join(os.tmpdir(), `worktree-move-${crypto.randomUUID()}.json`)),
          productDatabase: AbsolutePath.make(database.storage),
          routeID: undefined,
          engine: {
            exportMove: engines.exportMove,
            stageNative: destinationEngines.stageNative,
            activate: destinationEngines.activate,
          },
        })
      })
    const remind = (text: string) =>
      peers
        .admit({
          id: SessionMessage.ID.create(),
          sessionID,
          prompt: Prompt.make({ text: `<system-reminder>${text}</system-reminder>` }),
          delivery: "steer",
          resume: true,
        })
        .pipe(Effect.catch(() => Effect.void))
    return {
      enter_worktree: Tool.make({
        description:
          "Move this Session into a git worktree of its project. Every tool call afterwards runs in that directory; commit anything that matters before leaving with exit_worktree.",
        input: Schema.Struct({ name: Schema.optional(Schema.String) }),
        output: Schema.Struct({
          moved: Schema.Literal(true),
          directory: Schema.String,
          name: Schema.optional(Schema.String),
          branch: Schema.optional(Schema.String),
        }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `Moved to ${output.directory}` },
        ],
        execute: (input) =>
          Effect.gen(function* () {
            const found = yield* placement(sessionID).pipe(
              Effect.catch(() => new ToolFailure({ message: "Unable to locate the Session placement" })),
            )
            if (found?.engine !== "rust") {
              return yield* new ToolFailure({ message: "enter_worktree needs an engine-owned Session" })
            }
            const target = yield* placementRootFor(found.location.directory)
            if (!target) return yield* new ToolFailure({ message: "Worktrees need a git repository." })
            const created = yield* worktreeService
              .create(
                { projectID: target.projectID, checkout: target.checkout, git: true },
                input.name ? { name: input.name } : undefined,
              )
              .pipe(Effect.mapError(asMoveFailure("Unable to create the worktree")))
            const destination = { ...found.location, directory: AbsolutePath.make(created.directory) }
            yield* move({ storage: found.storage, location: found.location }, destination).pipe(
              Effect.mapError(asMoveFailure("Unable to move the Session into the worktree")),
            )
            yield* remind(
              `The Session now works in the git worktree "${created.name}" at "${created.directory}"` +
                `${created.branch ? ` on branch ${created.branch}` : ""}. Every tool call from here runs in that ` +
                `directory. Commit anything that matters before leaving with exit_worktree.`,
            )
            return {
              moved: true as const,
              directory: created.directory,
              ...(created.name ? { name: created.name } : {}),
              ...(created.branch ? { branch: created.branch } : {}),
            }
          }),
      }),
      exit_worktree: Tool.make({
        description:
          "Move this Session back into its project's primary checkout, optionally removing the worktree it occupies.",
        input: Schema.Struct({
          action: Schema.Union([Schema.Literal("keep"), Schema.Literal("remove")]),
        }),
        output: Schema.Struct({
          moved: Schema.Literal(true),
          directory: Schema.String,
          removed: Schema.optional(Schema.Boolean),
        }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `Back at ${output.directory}` },
        ],
        execute: (input) =>
          Effect.gen(function* () {
            const found = yield* placement(sessionID).pipe(
              Effect.catch(() => new ToolFailure({ message: "Unable to locate the Session placement" })),
            )
            if (found?.engine !== "rust") {
              return yield* new ToolFailure({ message: "exit_worktree needs an engine-owned Session" })
            }
            const target = yield* placementRootFor(found.location.directory)
            if (!target) return yield* new ToolFailure({ message: "Worktrees need a git repository." })
            if (target.worktree === target.checkout) {
              return yield* new ToolFailure({
                message: "This Session is already in the project's primary checkout.",
              })
            }
            const destination = { ...found.location, directory: target.checkout }
            yield* move({ storage: found.storage, location: found.location }, destination).pipe(
              Effect.mapError(asMoveFailure("Unable to move the Session back")),
            )
            const removed = input.action === "remove"
            if (removed) {
              yield* worktreeService
                .remove(
                  { projectID: target.projectID, checkout: target.checkout, git: true },
                  { directory: target.worktree },
                )
                .pipe(Effect.mapError(asMoveFailure("Unable to remove the worktree")))
            }
            yield* remind(
              `The Session is back in the project's primary checkout at "${target.checkout}".` +
                `${removed ? ` The worktree at "${target.worktree}" was removed.` : ""}`,
            )
            return {
              moved: true as const,
              directory: target.checkout,
              ...(removed ? { removed: true as const } : {}),
            }
          }),
      }),
    }
  }

  const make = (sessionID: SessionSchema.ID): Readonly<Record<string, Tool.AnyTool>> => ({
    ...PeerTools.make({ sessionID, permission, peers }),
    ...makeWorktreeTools(sessionID),
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
        // A worktree move ends the drain in the old location: the structured
        // marker travels to the engine, which settles the run at this tool.
        const structured = asRecord(output.structured)
        if (structured?.["moved"] === true) return structured
        return text.length > 0 ? text : output.structured
      }),
    )
  }
  return options
})

export * as ProductTools from "./product-tools"
