import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { Formatter } from "@miao/core/format/registry"
import { Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

export const prepare = Effect.fn("Engine.productFormatter")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.formatterConfigFile) return options
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  if (!config) return options
  const current = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!current || current.directory !== location.directory)
    return yield* Effect.fail(
      new EngineError("engine_formatter_location", "product formatter Location does not match owner"),
    )
  const configured = (yield* config.entries())
    .flatMap((entry) => (entry.type === "document" && entry.info.formatter !== undefined ? [entry.info.formatter] : []))
    .at(-1)
  if (!configured) return options
  const formatters = new Map<string, Formatter.Info>()
  for (const info of Object.values(Formatter)) {
    if (typeof info !== "object" || info === null || !("name" in info) || !("enabled" in info)) continue
    formatters.set(info.name, info)
  }
  if (configured !== true) {
    for (const [name, override] of Object.entries(configured)) {
      const builtIn = formatters.get(name)
      if (override.disabled) {
        formatters.delete(name)
        continue
      }
      formatters.set(name, {
        name,
        extensions: [...(override.extensions ?? builtIn?.extensions ?? [])],
        environment: override.environment ?? builtIn?.environment,
        enabled: override.command
          ? async () => [...(override.command ?? [])]
          : (builtIn?.enabled ?? (async () => false)),
      })
    }
  }
  const entries = yield* Effect.tryPromise({
    try: async () => {
      const entries = await Promise.all(
        Array.from(formatters.values()).map(async (formatter) => {
          const argv = await formatter.enabled({
            directory: location.directory,
            worktree: location.directory,
            experimentalOxfmt: false,
          })
          if (!argv) return undefined
          return { name: formatter.name, argv, extensions: formatter.extensions, env: formatter.environment ?? {} }
        }),
      )
      return entries.filter((entry) => entry !== undefined)
    },
    catch: () => new EngineError("engine_formatter_config", "could not resolve product formatters"),
  })
  if (entries.length === 0) return options
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-formatter-")),
      catch: () => new EngineError("engine_formatter_io", "could not create native formatter directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "formatter.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, JSON.stringify(entries), { mode: 0o600 }),
    catch: () => new EngineError("engine_formatter_io", "could not write native formatter manifest"),
  })
  options.formatterConfigFile = file
  return options
})

export * as ProductFormatter from "./product-formatter"
