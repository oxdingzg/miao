import { Location } from "@miao/schema/location"
import { ClientEvents } from "@miao/server/client-events"
import { Effect, Scope, Semaphore } from "effect"
import { EngineError, type EngineOptions } from "./client"
import { connectEngine } from "./connection"

/** Native children belong to the server scope, never to an individual HTTP request. */
export const makeEngineOwners = Effect.fn("Engine.owners")(function* (
  options: Omit<EngineOptions, "db" | "workspace">,
) {
  const clients = yield* ClientEvents.Service
  const scope = yield* Scope.make()
  const gate = Semaphore.makeUnsafe(1)
  const owners = new Map<
    string,
    {
      engineID: string
      location: Location.Ref
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
  return {
    get: Effect.fn("Engine.owners.get")(function* (input: {
      storage: string
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
            return existing.connection
          }
          const connection = yield* connectEngine({
            ...configuration,
            db: input.storage,
            workspace: input.location.directory,
            engineID: input.engineID,
            location: input.location,
          }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(ClientEvents.Service, clients))
          owners.set(input.storage, {
            engineID: input.engineID,
            location: { ...input.location },
            connection,
          })
          return connection
        }),
      )
    }),
  }
})
