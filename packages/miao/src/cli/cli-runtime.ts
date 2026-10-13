import { Effect, Layer, ManagedRuntime } from "effect"
import { Observability } from "@miao/core/observability"

import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { GitCli } from "@miao/core/git-cli"
import { Ripgrep } from "@miao/core/ripgrep"
import { ModelsCatalog } from "@miao/core/models-catalog"
import { McpAuth } from "@miao/core/mcp/auth"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { Npm } from "@miao/core/npm"
import { memoMap } from "@miao/core/effect/memo-map"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { cliRuntimeUsed } from "./cli-runtime-usage"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionSchedule } from "@miao/core/session/schedule"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { buildLocationServiceMap, LocationServiceMap } from "@miao/core/location-services"
import { Installation } from "@/installation"

/**
 * The CLI's core-only runtime: the global services the command handlers
 * resolve outside a location scope. Location-scoped services (Catalog,
 * AISDK, AgentV2, LSP, MCP, Config, Integration, Snapshot, SkillV2) resolve
 * through `locationScope` instead.
 */
const CliLayer = AppNodeBuilder.build(
  LayerNode.group([
    Npm.node,
    FSUtil.node,
    Blob.node,
    Database.node,
    EventV2.node,
    GitCli.node,
    ModelsCatalog.node,
    McpAuth.node,
    SessionProjector.node,
    SessionStore.node,
    SessionSchedule.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    ProjectMetadata.node,
    Installation.node,
  ]),
  [
    [LocationServiceMap.node, buildLocationServiceMap()],
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
).pipe(Layer.provideMerge(LayerNode.compile(Ripgrep.node)), Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(CliLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by the CLI runtime — i.e. what an Effect run via `CliRuntime.runPromise` can yield. */
export type CliServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = <A, E>(effect: Effect.Effect<A, E, CliServices>) => {
  cliRuntimeUsed.value = true
  return effect
}

export const CliRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
