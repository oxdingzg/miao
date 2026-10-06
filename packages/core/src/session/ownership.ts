export * as SessionOwnership from "./ownership"

import { createHash } from "node:crypto"
import path from "node:path"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { RuntimeOwnership } from "../runtime/ownership"
import type { SessionSchema } from "./schema"

export class BusyError extends Error {
  override readonly name = "SessionOwnership.BusyError"
  constructor(readonly sessionID: string) {
    super("This session is owned by another miao window. Close that window before continuing here.")
  }
}

export interface Interface {
  readonly claim: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly owned: (sessionID: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@miao/SessionOwnership") {}

/** A lease covers every turn and side effect, including idle time, until this runtime closes. */
export const make = (storage: string) =>
  Effect.gen(function* () {
    const owners = new Map<string, RuntimeOwnership.Owner | undefined>()
    const gate = Semaphore.makeUnsafe(1)
    const state = { closing: false }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.closing = true
      }).pipe(
        Effect.andThen(
          gate.withPermit(
            Effect.sync(() => {
              owners.forEach((owner) => owner?.release())
              owners.clear()
            }),
          ),
        ),
      ),
    )
    return Service.of({
      owned: (sessionID) => Effect.sync(() => owners.has(sessionID)),
      claim: (sessionID) =>
        gate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (state.closing) return yield* Effect.die("This miao window is closing")
              if (owners.has(sessionID)) return
              const owner =
                storage === ":memory:"
                  ? undefined
                  : yield* Effect.promise(async () => {
                      const canonical = await RuntimeOwnership.canonicalStorage(storage)
                      return RuntimeOwnership.acquireShared(
                        path.join(`${canonical}.sessions`, createHash("sha256").update(sessionID).digest("hex")),
                      ).catch((error: unknown) => {
                        if (error instanceof RuntimeOwnership.BusyError) throw new BusyError(sessionID)
                        throw error
                      })
                    })
              owners.set(sessionID, owner)
            }),
          ),
        ),
    })
  })

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* make(database.storage)
    }),
  ),
  deps: [Database.node],
})
