export * as SessionExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import type { SessionEvent } from "./event"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly executions: Effect.Effect<ReadonlyMap<SessionSchema.ID, string>>
  /** Current process status for the Session, including the active drain phase. */
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<SessionEvent.StatusInfo>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly interruptIf: (sessionID: SessionSchema.ID, execution: string) => Effect.Effect<boolean>
  /** Wait until the Session has no active execution in this process. Never fails. */
  readonly wait: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    executions: Effect.succeed(new Map()),
    status: () => Effect.succeed({ type: "idle" }),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    interruptIf: () => Effect.succeed(false),
    wait: () => Effect.void,
  }),
)
