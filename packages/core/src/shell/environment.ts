/**
 * Extra environment variables for shell commands the V2 bash tool runs, the
 * counterpart of the PTY environment. Plugins contribute them through the
 * `shell.env` hook; the host that loads plugins installs a source here.
 *
 * The service is process-global so one instance serves every Location: the
 * host installs its source once, and each Location's bash tool reads it.
 */
export * as ShellEnvironment from "./environment"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Input {
  /** The Location directory the command belongs to. */
  readonly directory: string
  /** The working directory the command runs in. */
  readonly cwd: string
  readonly sessionID: string
  readonly callID: string
}

export type Source = (input: Input) => Effect.Effect<Record<string, string>>

export interface Interface {
  /** Variables from every installed source, later sources overriding earlier ones. */
  readonly get: (input: Input) => Effect.Effect<Record<string, string>>
  /** Adds a source until the calling scope closes. */
  readonly install: (source: Source) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ShellEnvironment") {}

export const layer = Layer.sync(Service, () => {
  const sources = new Set<Source>()
  return Service.of({
    get: (input) =>
      Effect.forEach([...sources], (source) => source(input)).pipe(
        Effect.map((items) => Object.assign({}, ...items) as Record<string, string>),
      ),
    install: (source) =>
      Effect.acquireRelease(
        Effect.sync(() => sources.add(source)),
        () => Effect.sync(() => sources.delete(source)),
      ).pipe(Effect.asVoid),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
