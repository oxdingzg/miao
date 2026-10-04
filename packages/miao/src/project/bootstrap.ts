import { makeGlobalNode } from "@miao/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import { Vcs } from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@miao/core/event"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const events = yield* EventV2Bridge.Service
    const metadata = yield* ProjectMetadata.Service

    const initState = yield* InstanceState.make(
      Effect.fn("InstanceBootstrap.initState")(function* (ctx) {
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Command.Event.Executed.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Command.Event.Executed>
          return data.name === Command.Default.INIT ? metadata.setInitialized(ctx.project.id) : Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )

    const run = Effect.gen(function* () {
      yield* InstanceState.get(initState)
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, format, vcs, snapshot],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Format.node,
    LSP.node,
    Plugin.node,
    Snapshot.node,
    Vcs.node,
    EventV2Bridge.node,
    ProjectMetadata.node,
  ],
})

export * as InstanceBootstrap from "./bootstrap"
