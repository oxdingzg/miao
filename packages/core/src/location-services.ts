import { Effect, Layer, LayerMap } from "effect"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { BackgroundJob } from "./background-job"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { EventV2 } from "./event"
import { FileSystem } from "./filesystem"
import { Format } from "./format"
import { Git } from "./git"
import { FileSystemSearch } from "./filesystem/search"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { InstructionContext } from "./instruction-context"
import { Integration } from "./integration"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LSP } from "./lsp"
import { MCP } from "./mcp"
import { LocationServiceMap } from "./location-service-map"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { ProjectCopy } from "./project/copy"
import { ProjectRegistry } from "./project/registry"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionModel } from "./session/model"
import { SessionExecution } from "./session/execution"
import { SessionExecutionLocal } from "./session/execution/local"
import { SessionSchedule } from "./session/schedule"
import { SessionTodo } from "./session/todo"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { SystemContextRegistry } from "./system-context/registry"
import { BuiltInTools } from "./tool/builtins"
import { CustomTools } from "./tool/custom"
import { ToolPlugins } from "./tool/plugins"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group([
  Location.node,
  BackgroundJob.locationNode,
  EventV2.locationNode,
  SessionSchedule.locationNode,
  Policy.node,
  Config.node,
  AgentV2.node,
  CommandV2.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  AISDK.node,
  PluginV2.node,
  PluginInternal.node,
  ProjectRegistry.node,
  ProjectCopy.node,
  ProjectCopy.refreshNode,
  FileSystemSearch.node,
  FileSystem.node,
  Git.node,
  Watcher.node,
  Pty.node,
  SkillV2.node,
  SystemContextRegistry.node,
  InstructionContext.node,
  SystemContextBuiltIns.node,
  LocationMutation.node,
  FileMutation.node,
  Format.node,
  PermissionV2.node,
  LSP.node,
  MCP.node,
  ToolOutputStore.node,
  ToolPlugins.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Image.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  SessionTodo.node,
  QuestionV2.node,
  ReadToolFileSystem.node,
  BuiltInTools.node,
  CustomTools.node,
  SessionModel.node,
  Snapshot.node,
  SessionRunnerLLM.node,
])

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

/**
 * One location service map per replacement configuration. The map is a LayerMap
 * keyed by directory, so two requests that both resolve a directory must reach
 * the same LayerMap or the directory gets two full service graphs — two
 * PermissionV2 services with two pending maps, two `SessionExecution`s, and so
 * on. A permission asked through one graph is not visible to the other, which
 * strands the tool call waiting for an answer the reply route cannot find.
 *
 * This is why the empty configuration was cached before. A host that passes
 * replacements (for example the engine admission binding) must be cached the
 * same way, or its routes and the CLI runtime that owns the drain build against
 * different maps for the same directory.
 */
const maps = new Map<string, Layer.Layer<LocationServiceMap.Service>>()
const replacementIds = new WeakMap<object, number>()
let nextReplacementId = 1

/**
 * The map applies these replacements to every ref regardless of what the caller
 * passes, so a caller that repeats them is describing the same graph. Keeping
 * them in the key would hand that caller a second map — the exact split this
 * cache exists to prevent.
 */
const forcedReplacements = new Set([SessionExecution.node.name, Location.node.name])

function replacementKey(replacements: LayerNode.Replacements) {
  // Key by (source name, replacement identity), not by list order or length:
  // two callers describing the same graph must land on the same entry.
  const bySource = new Map<string, string>()
  for (const [node, replacement] of replacements) {
    if (forcedReplacements.has(node.name)) continue
    const known = replacementIds.get(replacement as object) ?? nextReplacementId++
    replacementIds.set(replacement as object, known)
    bySource.set(node.name, `${node.name}#${known}`)
  }
  return [...bySource.values()].sort().join("|")
}

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  const key = replacementKey(replacements)
  const cached = maps.get(key)
  if (cached) return cached
  const layer = Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(
      (ref: Location.Ref) => {
        const allReplacements: LayerNode.Replacements = [
          // The map itself, so a replacement subtree (e.g. the local session
          // execution below, which wakes locations) may depend on it. The
          // per-ref build runs after the map service exists and the memoMap
          // dedupes the self reference, so this is not a construction cycle.
          [LocationServiceMap.node, layer],
          ...replacements,
          // Default execution binding for hoisted subtrees that wake sessions
          // (the schedule's fire path). Caller replacements above override it.
          [SessionExecution.node, SessionExecutionLocal.node],
          [Location.node, Location.boundNode(ref)],
        ]
        // Apply replacements during hoist, not afterward: replacements can
        // introduce new tagged dependencies (Location.boundNode depends on
        // Project), and the hoist walk is the only pass that can still slice
        // those back out.
        const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)

        return LayerNode.compile(location.node).pipe(
          Layer.fresh,
          Layer.tap(() =>
            Effect.logInfo("booting location services", {
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }),
          ),
          Layer.provide(LayerNode.compile(location.hoisted)),
        )
      },
      { idleTimeToLive: "60 minutes" },
    ),
  )
  maps.set(key, layer)
  return layer
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
