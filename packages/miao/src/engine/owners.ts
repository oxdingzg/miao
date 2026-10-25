import { Location } from "@miao/schema/location"
import { ClientEvents } from "@miao/server/client-events"
import { Effect, Scope, Semaphore } from "effect"
import { EngineError, type EngineOptions } from "./client"
import { connectEngine } from "./connection"
import type { CredentialExpiredTrigger, EnginePricing } from "./session"

/** Native children belong to the server scope, never to an individual HTTP request. */
export const makeEngineOwners = Effect.fn("Engine.owners")(function* (
  options: Omit<EngineOptions, "db" | "workspace">,
  prepare?: (location: Location.Ref) => Effect.Effect<
    {
      options: Partial<EngineOptions>
      refresh: Effect.Effect<void, EngineError>
      pricing?: EnginePricing
      onCredentialExpired?: CredentialExpiredTrigger
    },
    EngineError,
    Scope.Scope
  >,
) {
  const clients = yield* ClientEvents.Service
  const scope = yield* Scope.make()
  const gate = Semaphore.makeUnsafe(1)
  const owners = new Map<
    string,
    {
      input: { storage: string; refreshContext?: boolean; engineID: string; location: Location.Ref }
      engineID: string
      location: Location.Ref
      refresh: Effect.Effect<void, EngineError>
      pricing?: EnginePricing
      onCredentialExpired?: CredentialExpiredTrigger
      connection: Effect.Success<ReturnType<typeof connectEngine>>
    }
  >()
  // Last observed timer_sessions count per storage. The supervisor re-owns a
  // dead child only when its last probe showed timers; every other dead
  // engine is released so an idle-reclaimed engine stays reclaimed.
  const timerMemory = new Map<string, number>()
  const state = { closing: false }
  const configuration = { ...options, ...(options.env ? { env: { ...options.env } } : {}) }
  yield* Effect.addFinalizer((exit) =>
    gate.withPermit(
      Effect.sync(() => {
        state.closing = true
      }).pipe(
        Effect.andThen(Scope.close(scope, exit)),
        Effect.ensuring(
          Effect.sync(() => {
            owners.clear()
            timerMemory.clear()
          }),
        ),
      ),
    ),
  )
  const get = Effect.fn("Engine.owners.get")(function* (input: {
    storage: string
    refreshContext?: boolean
    engineID: string
    location: Location.Ref
  }) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        if (state.closing)
          return yield* Effect.fail(new EngineError("engine_owner_closed", "native owner scope is closed"))
        const existing = owners.get(input.storage)
        if (existing) {
          if (
            existing.engineID !== input.engineID ||
            existing.location.directory !== input.location.directory ||
            existing.location.workspaceID !== input.location.workspaceID
          )
            return yield* Effect.fail(
              new EngineError(
                "engine_owner_conflict",
                "native storage already belongs to a different engine or Location",
              ),
            )
          if (existing.connection.client.available) {
            if (input.refreshContext) yield* existing.refresh
            return existing.connection
          }
          owners.delete(input.storage)
        }
        const context = prepare
          ? yield* prepare(input.location).pipe(Effect.provideService(Scope.Scope, scope))
          : { options: {}, refresh: Effect.void }
        const connection = yield* connectEngine(
          {
            ...configuration,
            ...context.options,
            db: input.storage,
            workspace: input.location.directory,
            engineID: input.engineID,
            location: input.location,
          },
          context.pricing,
          context.onCredentialExpired,
        ).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(ClientEvents.Service, clients))
        owners.set(input.storage, {
          input,
          refresh: context.refresh,
          engineID: input.engineID,
          location: { ...input.location },
          pricing: context.pricing,
          onCredentialExpired: context.onCredentialExpired,
          connection,
        })
        return connection
      }),
    )
  })
  const sweepTimers = Effect.fn("Engine.owners.sweepTimers")(function* () {
    // Network/process work must not hold the owner registry permit: recovery
    // goes through get(), and a failed probe must not deadlock every request.
    const snapshot = yield* gate.withPermit(Effect.sync(() => [...owners]))
    const results: { storage: string; sessions: Array<{ session_id: string }> }[] = []
    const probe = (connection: Effect.Success<ReturnType<typeof get>>) =>
      Effect.tryPromise({
        try: () =>
          connection.client.request("timer_sessions") as Promise<{
            sessions: Array<{ session_id: string }>
          }>,
        catch: (error) =>
          error instanceof EngineError
            ? error
            : new EngineError("engine_owner_sweep", "native timer session probe failed"),
      })
    const attempt = (connection: Effect.Success<ReturnType<typeof get>>) =>
      probe(connection).pipe(Effect.catch(() => Effect.succeed(null)))
    for (const [storage, owner] of snapshot) {
      const probed = yield* attempt(owner.connection)
      if (owners.get(storage) !== owner) continue
      if (probed === null) {
        // A live child that fails the probe stays: the next real request
        // surfaces the engine error instead of a silent replacement.
        if (owner.connection.client.available) continue
        // A dead child still holds unresolved timers; re-owning spawns a
        // fresh engine whose startup adoption re-arms and fires them. A
        // timer armed after the last probe waits for the next request to
        // the storage, which re-owns and adopts the durable record.
        if ((timerMemory.get(storage) ?? 0) > 0) {
          const reowned = yield* get({ ...owner.input, refreshContext: true }).pipe(
            Effect.catch(() => Effect.succeed(null)),
          )
          if (reowned === null) continue
          const recovered = yield* attempt(reowned)
          if (recovered === null) continue
          if (owners.get(storage)?.connection !== reowned) continue
          timerMemory.set(storage, recovered.sessions.length)
          results.push({ storage, sessions: recovered.sessions })
          continue
        }
        yield* gate.withPermit(
          Effect.sync(() => {
            // get() may replace the dead connection while this sweep waits
            // for the registry permit. Only release the snapshotted owner.
            if (owners.get(storage) !== owner) return
            owners.delete(storage)
            timerMemory.delete(storage)
          }),
        )
        continue
      }
      timerMemory.set(storage, probed.sessions.length)
      results.push({ storage, sessions: probed.sessions })
    }
    return results
  })
  return { get, sweepTimers }
})
