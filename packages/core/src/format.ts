export * as Format from "./format"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "./process"
import { Config } from "./config"
import { Location } from "./location"
import { makeLocationNode } from "./effect/app-node"
import * as Formatter from "./format/registry"

export interface Interface {
  /** Runs every configured formatter that matches the file's extension. Returns false when none apply. */
  readonly file: (filepath: string) => Effect.Effect<boolean>
  /** Reports each configured formatter and whether its command is available. */
  readonly status: () => Effect.Effect<Status[]>
}

export interface Status {
  readonly name: string
  readonly extensions: ReadonlyArray<string>
  readonly enabled: boolean
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Format") {}

type Resolved = {
  readonly name: string
  readonly extensions: ReadonlyArray<string>
  readonly environment?: Record<string, string>
  readonly command?: ReadonlyArray<string>
  readonly enabled?: (context: Formatter.Context) => Promise<string[] | false>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const location = yield* Location.Service

    const context: Formatter.Context = {
      directory: location.directory,
      worktree: location.directory,
      experimentalOxfmt: false,
    }

    const entries = yield* config.entries()
    let configured: Config.Info["formatter"]
    for (const entry of entries)
      if (entry.type === "document" && entry.info.formatter !== undefined) configured = entry.info.formatter

    const resolved: Record<string, Resolved> = {}
    if (configured) {
      for (const info of Object.values(Formatter)) {
        if (typeof info !== "object" || info === null || !("name" in info) || !("enabled" in info)) continue
        resolved[info.name] = {
          name: info.name,
          extensions: info.extensions,
          environment: info.environment,
          enabled: (ctx) => info.enabled(ctx),
        }
      }
      if (configured !== true) {
        for (const [name, override] of Object.entries(configured)) {
          const builtIn = resolved[name]
          if (override.disabled) {
            delete resolved[name]
            continue
          }
          resolved[name] = {
            name,
            extensions: override.extensions ?? builtIn?.extensions ?? [],
            environment: override.environment ?? builtIn?.environment,
            command: override.command,
            enabled: override.command ? undefined : builtIn?.enabled,
          }
        }
      }
    }

    const file = Effect.fn("Format.file")(function* (filepath: string) {
      const extension = path.extname(filepath)
      const matching = Object.values(resolved).filter((item) => item.extensions.includes(extension))
      if (matching.length === 0) return false
      for (const item of matching) {
        const command = item.command ?? (item.enabled ? yield* Effect.promise(() => item.enabled!(context)) : false)
        if (!command) continue
        const replaced = command.map((part) => part.replace("$FILE", filepath))
        yield* appProcess
          .run(
            ChildProcess.make(replaced[0], replaced.slice(1), {
              cwd: location.directory,
              env: item.environment,
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(Effect.ignore)
      }
      return true
    })

    const status = Effect.fn("Format.status")(function* () {
      const result: Status[] = []
      for (const item of Object.values(resolved)) {
        const command = item.command ?? (item.enabled ? yield* Effect.promise(() => item.enabled!(context)) : false)
        result.push({ name: item.name, extensions: [...item.extensions], enabled: Boolean(command) })
      }
      return result
    })

    return Service.of({ file, status })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, AppProcess.node, Location.node],
})
