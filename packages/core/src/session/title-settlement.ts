export * as SessionTitleSettlement from "./title-settlement"

import { Context, Deferred, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"

export class Service extends Context.Service<
  Service,
  {
    readonly begin: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly finish: Effect.Effect<void> }>
    readonly wait: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  }
>()("@miao/SessionTitleSettlement") {}

// Only completion tickets are process-global. The model call and its lifetime
// remain owned by the Location runner; an idle waiter never boots a Location.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const pending = new Map<SessionSchema.ID, Deferred.Deferred<void>>()
      return Service.of({
        begin: (sessionID) =>
          Effect.gen(function* () {
            const settled = yield* Deferred.make<void>()
            pending.set(sessionID, settled)
            return {
              finish: Effect.gen(function* () {
                yield* Deferred.succeed(settled, undefined)
                if (pending.get(sessionID) === settled) pending.delete(sessionID)
              }),
            }
          }),
        wait: (sessionID) =>
          Effect.suspend(() => {
            const settled = pending.get(sessionID)
            return settled
              ? Deferred.await(settled).pipe(Effect.timeoutOption("30 seconds"), Effect.asVoid)
              : Effect.void
          }),
      })
    }),
  ),
  deps: [],
})
