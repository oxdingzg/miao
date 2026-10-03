export * as ToolPlugins from "./plugins"

import { ToolFailure } from "@miao/llm"
import type { ToolDefinition as PluginToolDefinition } from "@miao/plugin/tool"
import { Cause, Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import type { State } from "../state"

/**
 * Plugin-facing extension points of the Location tool registry: the V2
 * `tool.execute.before` / `tool.execute.after` / `tool.definition` hooks,
 * plugin-provided tool definitions, and deferred tool loading.
 *
 * This service has no dependencies so both the plugin host and the registry can
 * depend on it without a `PluginBoot -> Tools -> PluginBoot` cycle.
 */

export interface BeforeEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly agent: string
  /** Raw provider input. Replace it to change what the tool receives. */
  args: unknown
}

export interface AfterEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly agent: string
  readonly args: unknown
  /** V2 tools have no title; kept for V1 hook signature parity and ignored. */
  title: string
  /** Model-facing text. Replacing it replaces the text content of the result. */
  output: string
  /** The tool's structured output. Replacing it replaces the structured result. */
  metadata: unknown
}

export interface DefinitionEvent {
  readonly tool: string
  description: string
  parameters: unknown
}

export type Callback<Event> = (event: Event) => Effect.Effect<void, unknown> | void
export type Hook<Event> = (callback: Callback<Event>) => Effect.Effect<State.Registration, never, Scope.Scope>
export type ProvidedTools = Readonly<Record<string, PluginToolDefinition>>

export interface Interface {
  readonly hook: {
    readonly before: Hook<BeforeEvent>
    readonly after: Hook<AfterEvent>
    readonly definition: Hook<DefinitionEvent>
  }
  readonly has: (name: "before" | "after" | "definition") => boolean
  /** Runs before hooks in registration order. A throwing or failing hook rejects the call. */
  readonly runBefore: (event: BeforeEvent) => Effect.Effect<BeforeEvent, ToolFailure>
  /** Runs after hooks in registration order. A throwing or failing hook turns the result into a tool error. */
  readonly runAfter: (event: AfterEvent) => Effect.Effect<AfterEvent, ToolFailure>
  /** Runs definition hooks. A failing hook is logged and skipped so one plugin cannot break a provider turn. */
  readonly runDefinition: (event: DefinitionEvent) => Effect.Effect<DefinitionEvent>
  /** Offers plugin-authored tool definitions; they stay available until the returned registration closes. */
  readonly provide: (tools: ProvidedTools) => Effect.Effect<State.Registration, never, Scope.Scope>
  /**
   * Installs the single consumer that turns provided definitions into canonical
   * tools. Each provided record runs in its own child Scope, closed when the
   * provider disposes it.
   */
  readonly listen: (
    consumer: (tools: ProvidedTools) => Effect.Effect<void, never, Scope.Scope>,
  ) => Effect.Effect<void, never, Scope.Scope>
  /**
   * Defers loading work until the first materialization needs tools, so loading
   * custom tools never delays Location boot. The work runs once, in this
   * service's scope, even when the first waiter is interrupted.
   */
  readonly defer: (load: Effect.Effect<void>) => Effect.Effect<void>
  /** Starts every deferred load and waits for all of them. */
  readonly ready: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/ToolPlugins") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const hooks = {
      before: [] as Callback<BeforeEvent>[],
      after: [] as Callback<AfterEvent>[],
      definition: [] as Callback<DefinitionEvent>[],
    }
    const provided = new Set<{ readonly tools: ProvidedTools; child?: Scope.Closeable }>()
    const consumer: {
      run?: (tools: ProvidedTools) => Effect.Effect<void, never, Scope.Scope>
      scope?: Scope.Scope
    } = {}
    const loads: { readonly effect: Effect.Effect<void>; readonly done: Deferred.Deferred<void>; started: boolean }[] =
      []

    const register =
      <Name extends keyof typeof hooks>(name: Name) =>
      (callback: (typeof hooks)[Name][number]) =>
        Effect.gen(function* () {
          const owner = yield* Scope.Scope
          const list = hooks[name] as unknown[]
          list.push(callback)
          const dispose = Effect.sync(() => {
            const index = list.indexOf(callback)
            if (index >= 0) list.splice(index, 1)
          })
          yield* Scope.addFinalizer(owner, dispose)
          return { dispose }
        })

    const invoke = <Event>(callback: Callback<Event>, event: Event) =>
      Effect.suspend(() => {
        const result = callback(event)
        return Effect.isEffect(result) ? result : Effect.void
      })

    const reject = (name: string) =>
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(
              new ToolFailure({ message: `${name} hook rejected the call: ${message(Cause.squash(cause))}` }),
            ),
      )

    const attach = (entry: { readonly tools: ProvidedTools; child?: Scope.Closeable }) =>
      Effect.gen(function* () {
        if (!consumer.run || !consumer.scope) return
        const child = yield* Scope.fork(consumer.scope)
        entry.child = child
        yield* consumer.run(entry.tools).pipe(Scope.provide(child))
      })

    return Service.of({
      hook: {
        before: register("before"),
        after: register("after"),
        definition: register("definition"),
      },
      has: (name) => hooks[name].length > 0,
      runBefore: (event) =>
        Effect.forEach([...hooks.before], (callback) => invoke(callback, event).pipe(reject("tool.execute.before")), {
          discard: true,
        }).pipe(Effect.as(event)),
      runAfter: (event) =>
        Effect.forEach([...hooks.after], (callback) => invoke(callback, event).pipe(reject("tool.execute.after")), {
          discard: true,
        }).pipe(Effect.as(event)),
      runDefinition: (event) =>
        Effect.forEach(
          [...hooks.definition],
          (callback) =>
            invoke(callback, event).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.logWarning("tool.definition hook failed", { tool: event.tool, cause: Cause.pretty(cause) }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.as(event)),
      provide: Effect.fnUntraced(function* (tools) {
        const owner = yield* Scope.Scope
        const entry: { readonly tools: ProvidedTools; child?: Scope.Closeable } = { tools }
        provided.add(entry)
        yield* attach(entry)
        const dispose = Effect.suspend(() => {
          if (!provided.delete(entry)) return Effect.void
          return entry.child ? Scope.close(entry.child, Exit.void) : Effect.void
        })
        yield* Scope.addFinalizer(owner, dispose)
        return { dispose }
      }),
      listen: Effect.fnUntraced(function* (run) {
        consumer.run = run
        consumer.scope = yield* Scope.Scope
        yield* Effect.forEach([...provided], attach, { discard: true })
      }),
      defer: (effect) =>
        Effect.sync(() => {
          loads.push({ effect, done: Deferred.makeUnsafe<void>(), started: false })
        }),
      ready: Effect.suspend(() =>
        Effect.forEach(
          [...loads],
          (load) =>
            Effect.suspend(() => {
              if (load.started) return Effect.void
              load.started = true
              return load.effect.pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(load.done, exit)),
                Effect.forkIn(scope),
                Effect.asVoid,
              )
            }).pipe(Effect.andThen(Deferred.await(load.done))),
          { discard: true },
        ),
      ),
    })
  }),
)

function message(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })
