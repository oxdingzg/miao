export * as CustomTools from "./custom"

import path from "path"
import { pathToFileURL } from "url"
import { Cause, Effect, Layer, Scope } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { PluginTool } from "./plugin-tool"
import { ToolPlugins } from "./plugins"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

/**
 * Registers custom tools for a Location:
 *
 * - `{tool,tools}/*.{js,ts}` in every config directory (global config dir, then
 *   project `.miao`/`.opencode` dirs, then `MIAO_CONFIG_DIR`), matching V1. The
 *   default export is named after the file; any other named export becomes
 *   `<file>_<export>`. Later directories win on a name collision.
 * - Tools plugins provide through `context.tool.register(...)`.
 *
 * File discovery and import are deferred until the first materialization, so a
 * Location with custom tools boots (and the TUI starts) without importing them.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const plugins = yield* ToolPlugins.Service
    const tools = yield* Tools.Service
    const scope = yield* Scope.Scope
    const services = { permission, directory: location.directory, worktree: location.project.directory }

    // Register each tool on its own so one invalid name cannot drop its siblings.
    const register = (definitions: ReadonlyArray<readonly [string, PluginTool.Definition]>) =>
      Effect.forEach(
        definitions,
        ([name, definition]) =>
          tools
            .register({ [name]: PluginTool.make(name, definition, services) })
            .pipe(Effect.catch((error) => Effect.logWarning("skipping custom tool", { name, error: error.message }))),
        { discard: true },
      )

    yield* plugins.defer(
      Effect.gen(function* () {
        const directories = (yield* config.entries()).flatMap((entry) =>
          entry.type === "directory" ? [entry.path] : [],
        )
        const files = yield* Effect.forEach(directories, (directory) =>
          fs
            .glob("{tool,tools}/*.{js,ts}", {
              cwd: directory,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(
              Effect.map((matches) => matches.toSorted()),
              Effect.orElseSucceed((): string[] => []),
            ),
        )
        const loaded = yield* Effect.forEach(files.flat(), (file) =>
          Effect.tryPromise(() => import(pathToFileURL(file).href)).pipe(
            Effect.map((mod: Record<string, unknown>) => {
              const namespace = path.basename(file, path.extname(file))
              return Object.entries(mod).flatMap(([id, value]) =>
                PluginTool.is(value) ? [[id === "default" ? namespace : `${namespace}_${id}`, value] as const] : [],
              )
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to load custom tool", { file, cause: Cause.pretty(cause) }).pipe(Effect.as([])),
            ),
          ),
        )
        yield* register(loaded.flat()).pipe(Scope.provide(scope))
      }),
    )

    yield* plugins.listen((provided) => register(Object.entries(provided)))
  }),
)

export const node = makeLocationNode({
  name: "custom-tools",
  layer,
  deps: [Config.node, FSUtil.node, Location.node, PermissionV2.node, ToolPlugins.node, ToolRegistry.toolsNode],
})
