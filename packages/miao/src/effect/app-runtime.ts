import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@miao/core/observability"

import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { GitCli } from "@miao/core/git-cli"
import { Ripgrep } from "@miao/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@miao/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@miao/core/mcp/auth"
import { Command } from "@/command"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { Npm } from "@miao/core/npm"
import { memoMap } from "@miao/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { buildLocationServiceMap, LocationServiceMap } from "@miao/core/location-services"

export const AppLayer = AppNodeBuilderV1.build(
  LayerNode.group([
    Npm.node,
    FSUtil.node,
    Blob.node,
    Database.node,
    EventV2.node,
    Auth.node,
    Config.node,
    GitCli.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelsDev.node,
    Provider.node,
    ProviderAuth.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    SessionProjector.node,
    SessionStore.node,
    BackgroundJob.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    LSP.node,
    MCP.node,
    McpAuth.node,
    Command.node,
    Format.node,
    InstanceStore.node,
    ProjectMetadata.node,
    Vcs.node,
    Worktree.node,
    Installation.node,
  ]),
  [
    [LocationServiceMap.node, buildLocationServiceMap()],
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
).pipe(Layer.provideMerge(AppNodeBuilderV1.build(Ripgrep.node)), Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
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
