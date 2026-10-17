import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { Deferred, Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

/** Trusted product configuration becomes a host-owned hooks manifest. Hooks
 * are fixed for a child's lifetime: changing them requires a new engine owner.
 * An explicit hooksConfigFile always takes precedence.
 */
export const prepare = Effect.fn("Engine.productHooks")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.hooksConfigFile) return options
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  if (!config) return {}
  const entries = (yield* config.entries()).flatMap((entry) =>
    entry.type === "document" ? (entry.info.hooks?.entries ?? []) : [],
  )
  if (entries.length === 0) return {}
  if (entries.length > 16)
    return yield* Effect.fail(
      new EngineError("engine_hooks_limit", "configuration supports at most 16 lifecycle hooks"),
    )
  const current = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!current || current.directory !== location.directory)
    return yield* Effect.fail(new EngineError("engine_hooks_location", "product hooks Location does not match owner"))
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-hooks-")),
      catch: () => new EngineError("engine_hooks_io", "could not create native hooks directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "hooks.json")
  yield* Effect.tryPromise({
    try: () =>
      Bun.write(
        file,
        JSON.stringify(
          entries.map((entry) => ({
            event: entry.event,
            tool: entry.tool ?? "*",
            argv: entry.command,
            ...(entry.timeout_ms === undefined ? {} : { timeout_ms: entry.timeout_ms }),
          })),
        ),
      ),
    catch: () => new EngineError("engine_hooks_io", "could not write native hooks manifest"),
  })
  options.hooksConfigFile = file
  return options
})

export * as ProductHooks from "./product-hooks"
