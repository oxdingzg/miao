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
  const state = { closing: false }
  const configuration = { ...options, ...(options.env ? { env: { ...options.env } } : {}) }
  yield* Effect.addFinalizer((exit) =>
    gate.withPermit(
      Effect.sync(() => {
        state.closing = true
      }).pipe(Effect.andThen(Scope.close(scope, exit)), Effect.ensuring(Effect.sync(() => owners.clear()))),
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
    for (const [storage, owner] of snapshot) {
      // A dead child still holds unresolved timers; re-owning spawns a
      // fresh engine whose startup adoption re-arms and fires them.
      const sessions = yield* probe(owner.connection).pipe(
        Effect.catch((error) =>
          owner.connection.client.available
            ? Effect.fail(error)
            : Effect.flatMap(get({ ...owner.input, refreshContext: true }), (connection) => probe(connection)),
        ),
      )
      results.push({ storage, sessions: sessions.sessions })
    }
    return results
  })
  return { get, sweepTimers }
})
