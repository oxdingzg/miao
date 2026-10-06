export * as Lint from "./lint"

import path from "path"
import { Context, Effect, Layer, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "./process"
import { Config } from "./config"
import { Location } from "./location"
import { makeLocationNode } from "./effect/app-node"

/** One configured linter that failed for the edited file. */
export interface Failure {
  readonly name: string
  readonly message: string
}

export interface Interface {
  /**
   * Runs every configured linter matching the file's extension and returns the
   * failures only; a passing or timed-out linter contributes nothing.
   */
  readonly file: (filepath: string) => Effect.Effect<ReadonlyArray<Failure>>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Lint") {}

/** A hung linter must never stall the edit loop; it is skipped instead. */
const LINT_TIMEOUT = "15 seconds"

const MAX_MESSAGE_CHARS = 2_000

type Resolved = {
  readonly name: string
  readonly extensions: ReadonlyArray<string>
  readonly environment?: Record<string, string>
  readonly command: ReadonlyArray<string>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const location = yield* Location.Service

    const entries = yield* config.entries()
    const resolved: Record<string, Resolved> = {}
    for (const entry of entries) {
      if (entry.type !== "document" || entry.info.linter === undefined || entry.info.linter === true) continue
      const section = entry.info.linter
      if (section === false) continue
      for (const [name, override] of Object.entries(section)) {
        if (override.disabled) {
          delete resolved[name]
          continue
        }
        resolved[name] = {
          name,
          extensions: override.extensions ?? [],
          environment: override.environment,
          command: override.command ?? [],
        }
      }
    }

    const file = Effect.fn("Lint.file")(function* (filepath: string) {
      const extension = path.extname(filepath)
      const failures: Failure[] = []
      for (const item of Object.values(resolved)) {
        if (!item.extensions.includes(extension) || item.command.length === 0) continue
        const replaced = item.command.map((part) => part.replace("$FILE", filepath))
        const result = yield* appProcess
          .run(
            ChildProcess.make(replaced[0], replaced.slice(1), {
              cwd: location.directory,
              env: item.environment,
              extendEnv: true,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
            { timeout: LINT_TIMEOUT },
          )
          .pipe(Effect.option)
        if (Option.isNone(result)) continue
        if (result.value.exitCode === 0) continue
        const decoder = new TextDecoder()
        const output = [decoder.decode(result.value.stderr), decoder.decode(result.value.stdout)]
          .filter((part) => part.trim().length > 0)
          .join("\n")
        const trimmed = output.trim()
        failures.push({
          name: item.name,
          message: trimmed.length > MAX_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}...` : trimmed,
        })
      }
      return failures
    })

    return Service.of({ file })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, AppProcess.node, Location.node],
})
