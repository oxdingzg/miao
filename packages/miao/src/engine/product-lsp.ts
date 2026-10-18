import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { LSPServer } from "@miao/core/lsp/server"
import { which } from "@miao/core/util/which"
import { Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

/** Use the same configured servers as the product; an explicit native manifest wins. */
export const prepare = Effect.fn("Engine.productLsp")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.lspConfigFile) return options
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  if (!config) return options
  const current = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!current || current.directory !== location.directory)
    return yield* Effect.fail(new EngineError("engine_lsp_location", "product LSP Location does not match owner"))
  const configured = (yield* config.entries())
    .flatMap((entry) => (entry.type === "document" && entry.info.lsp !== undefined ? [entry.info.lsp] : []))
    .at(-1)
  if (!configured) return options
  const servers = new Map(LSPServer.servers.map((server) => [server.id, server]))
  if (configured !== true) {
    for (const [id, override] of Object.entries(configured)) {
      if (override.disabled === true) {
        servers.delete(id)
        continue
      }
      if (!("command" in override)) continue
      servers.set(id, {
        id,
        command: override.command,
        extensions: override.extensions ?? servers.get(id)?.extensions ?? [],
        environment: override.env,
        initialization: override.initialization,
      })
    }
  }
  const entries = Array.from(servers.values()).flatMap((server) => {
    const executable = server.command[0] ? which(server.command[0]) : undefined
    if (!executable) return []
    return [
      {
        name: server.id,
        argv: [executable, ...server.command.slice(1)],
        extensions: server.extensions,
        env: server.environment ?? {},
        initialization: server.initialization ?? null,
      },
    ]
  })
  if (entries.length === 0) return options
  if (entries.length > 8)
    return yield* Effect.fail(new EngineError("engine_lsp_limit", "native LSP supports at most 8 installed servers"))
  const extensions = entries.flatMap((entry) =>
    entry.extensions.map((extension) => extension.replace(/^\./, "").toLowerCase()),
  )
  if (new Set(extensions).size !== extensions.length)
    return yield* Effect.fail(
      new EngineError("engine_lsp_overlap", "native LSP requires one configured server per extension"),
    )
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-lsp-")),
      catch: () => new EngineError("engine_lsp_io", "could not create native LSP directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "lsp.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, JSON.stringify(entries), { mode: 0o600 }),
    catch: () => new EngineError("engine_lsp_io", "could not write native LSP manifest"),
  })
  options.lspConfigFile = file
  return options
})

export * as ProductLsp from "./product-lsp"
