export * as SessionRunner from "./index"

import type { LLMError } from "@miao/llm"
import { Context, Effect } from "effect"
import type { BusyPhase } from "@miao/schema/session-event"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, LegacyNotMigratedError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"
import type { SessionDelegation } from "../delegation"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | LegacyNotMigratedError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error

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
    /** Reports local drain phases so a client can tell preparation from a dispatched request. */
    readonly phase?: (phase: BusyPhase) => Effect.Effect<void>
  }) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionRunner") {}
