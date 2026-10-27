export * as SessionAdmission from "./admission"

import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionInput } from "./input"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"

/**
 * The one admission entry every prompt and cancel goes through. The placement
 * owner decides which durable inbox receives the input; S2 routes every
 * Session through the engine's `engine_input`, leaving `session_input` as a
 * read-only projection (specs/s2-single-inbox.md Option 2).
 */
export interface Interface {
  /**
   * Admit one prompt under a caller-chosen identity. Conflicts surface as the
   * `SessionInput.LifecycleConflict` defect, so callers keep their existing
   * receipt and conflict mapping.
   */
  readonly admit: (input: {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
    readonly prompt: Prompt
    readonly delivery: SessionInput.Delivery
  }) => Effect.Effect<SessionInput.Admitted>
  /**
   * Cancel one pending input before its owner promotes it. `false` means the
   * input is unknown to the owner or already promoted.
   */
  readonly cancel: (input: {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionAdmission") {}

/**
 * The pre-S2 writer: publish `PromptAdmitted` straight into the TypeScript
 * journal. Compositions that have not bound an engine-owner implementation
 * keep exactly today's behavior.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return Service.of({
      admit: (input) => SessionInput.admit(db, events, input),
      cancel: (input) => SessionInput.cancel(db, events, input),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Database.node, EventV2.node],
})
