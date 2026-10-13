import { Context, Effect } from "effect"
import type { ConflictError } from "@miao/protocol/errors"
import type { Location } from "@miao/schema/location"
import type { SessionID } from "@miao/schema/session-id"
import type { SessionInput } from "@miao/schema/session-input"
import type { SessionMessage } from "@miao/schema/session-message"
import type { AbsolutePath } from "@miao/core/schema"

export interface Interface {
  /**
   * Admit one durable prompt into the native engine that owns the Session.
   * The placement catalog's storage and Location are authoritative; the engine
   * child is owned by the server scope, never by the calling request.
   */
  readonly admit: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    id?: SessionMessage.ID
    /** Only the text reaches native admission; richer inputs are refused. */
    prompt: { readonly text: string }
    delivery?: "steer" | "queue"
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, ConflictError>
  /**
   * The engine-owned Session snapshot. TypeScript handlers cannot serve this
   * for a native Session: their catalog does not contain it.
   */
  readonly snapshot: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<Readonly<Record<string, unknown>>, ConflictError>
  /** Every engine-owned Session in one storage. */
  readonly sessions: (input: {
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<readonly unknown[], ConflictError>
}

/**
 * Production native-engine transport. The TypeScript assembly declares this
 * service; the composition root provides it when a native engine binary is
 * configured. Without it, native-owned Sessions stay refused so a request can
 * never reach TypeScript handlers that do not own their storage.
 */
export class Service extends Context.Service<Service, Interface>()("@miao/NativeEngine") {}

/**
 * Request-scoped placement for a native-owned Session, resolved by the
 * location middleware and consumed by the handler branch. Present only when
 * the native transport is composed.
 */
export class Placement extends Context.Service<
  Placement,
  {
    readonly storage: AbsolutePath
    readonly location: Location.Ref
  }
>()("@miao/NativePlacement") {}

export * as NativeEngine from "./native-engine"
