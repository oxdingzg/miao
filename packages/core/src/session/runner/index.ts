export * as SessionRunner from "./index"

import { Context, Effect } from "effect"
import type { BusyPhase } from "@miao/schema/session-event"
import { SessionSchema } from "../schema"
import type { ExecutionError } from "../error"
import type { SessionDelegation } from "../delegation"

/** Compatibility name for callers that still implement the TypeScript runner. */
export type RunError = ExecutionError

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    /**
     * Wakes a peer Session after `send_message` admits to it. Omitted by callers
     * that only record durable input; the message is then delivered on the
     * target's next drain.
     */
    readonly wake?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
    /** Runtime-owned background execution capability, injected without a tag cycle. */
    readonly delegation?: SessionDelegation.API
    /**
     * Reports local drain phases so a client can tell preparation from a dispatched
     * request, with the slice progress of a phase that has any.
     */
    readonly phase?: (
      phase: BusyPhase,
      progress?: { readonly stage: number; readonly stages: number },
    ) => Effect.Effect<void>
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionRunner") {}
