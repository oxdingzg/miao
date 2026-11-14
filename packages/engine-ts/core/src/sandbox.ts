export * as Sandbox from "./sandbox"

/**
 * Location-scoped OS sandbox for shell commands. It resolves the effective
 * settings (config plus `MIAO_SANDBOX*` environment overrides) and wraps one
 * shell script in the sandbox runner. It does not decide escalation: the bash
 * leaf owns permission prompts and retries.
 *
 * Only the bash tool wraps its commands. Internal process users (git, ripgrep,
 * formatters) go through `AppProcess` unwrapped.
 */
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { SandboxPolicy } from "./sandbox/policy"
import { SandboxRunner } from "./sandbox/runner"

export type Backend = SandboxRunner.Backend

export interface Status {
  /** Sandboxing is requested by config or environment. */
  readonly enabled: boolean
  /** A runner and kernel backend exist on this host. */
  readonly available: boolean
  readonly backend?: Backend
  readonly network: boolean
  readonly onUnavailable: "warn" | "fail"
}

export interface WrapInput {
  readonly shell: string
  readonly script: string
  readonly cwd: string
  /** Writable directories beyond the defaults, such as approved external paths. */
  readonly writable: readonly string[]
  readonly options?: ChildProcess.CommandOptions
}

export interface Wrapped {
  readonly command: ChildProcess.Command
  readonly backend: Backend
  /** Canonical writable roots the sandbox allowed for this run. */
  readonly writable: readonly string[]
  /** Read and remove the runner's deny report after the command exits. */
  readonly denied: Effect.Effect<string[]>
}

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  /** Wrap a shell script, or return `undefined` when the sandbox is off or unavailable. */
  readonly wrap: (input: WrapInput) => Effect.Effect<Wrapped | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Sandbox") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const configs = (yield* config.entries()).flatMap((entry) =>
      entry.type === "document" && entry.info.sandbox ? [entry.info.sandbox] : [],
    )
    // Environment overrides are read per call so a running process honors
    // MIAO_SANDBOX changes the same way the V1 flag getters do.
    const settings = () => SandboxPolicy.settings(configs, process.env)
    let warned = false

    const status = Effect.fn("Sandbox.status")(function* () {
      const current = settings()
      const backend = SandboxRunner.backend()
      const available = backend !== undefined && SandboxRunner.resolve() !== undefined
      if (current.enabled && !available && !warned) {
        warned = true
        yield* Effect.logWarning("sandbox requested but no sandbox runner is available; bash runs unsandboxed", {
          platform: process.platform,
        })
      }
      return {
        enabled: current.enabled,
        available,
        ...(backend ? { backend } : {}),
        network: current.network,
        onUnavailable: current.onUnavailable,
      } satisfies Status
    })

    const wrap = Effect.fn("Sandbox.wrap")(function* (input: WrapInput) {
      const current = settings()
      const backend = SandboxRunner.backend()
      const runner = SandboxRunner.resolve()
      if (!current.enabled || !backend || !runner) return undefined
      const workdirs = unique(yield* Effect.forEach([location.directory, input.cwd], (item) => fs.resolve(item)))
      const configured = current.writableRoots.map((root) => path.resolve(location.directory, expandHome(root)))
      const extra = unique(
        yield* Effect.forEach([os.tmpdir(), ...configured, ...input.writable], (item) => fs.resolve(item)),
      ).filter((item) => !workdirs.includes(item))
      const report = path.join(os.tmpdir(), `miao-sbx-${crypto.randomUUID()}.json`)
      return {
        command: ChildProcess.make(
          runner.program,
          [
            ...runner.prefix,
            ...SandboxPolicy.args(
              { command: [input.shell, "-c", input.script], workdirs, allowNetwork: current.network },
              extra,
              report,
            ),
          ],
          input.options,
        ),
        backend,
        writable: [...workdirs, ...extra],
        denied: Effect.promise(async () => {
          const denied = await SandboxPolicy.readDenyReport(report)
          await Bun.file(report)
            .delete()
            .catch(() => {})
          return denied
        }),
      } satisfies Wrapped
    })

    return Service.of({ status, wrap })
  }),
)

function unique(items: readonly string[]) {
  return [...new Set(items)]
}

function expandHome(item: string) {
  if (item === "~") return os.homedir()
  if (item.startsWith("~/")) return path.join(os.homedir(), item.slice(2))
  return item
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node],
})
