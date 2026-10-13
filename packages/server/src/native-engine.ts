import { Context, Effect } from "effect"
import type { OpenCodeEvent } from "@miao/protocol/groups/event"
import type { ConflictError } from "@miao/protocol/errors"
import type { Location } from "@miao/schema/location"
import type { SessionID } from "@miao/schema/session-id"
import type { SessionInput } from "@miao/schema/session-input"
import type { SessionMessage } from "@miao/schema/session-message"
import type { AbsolutePath } from "@miao/core/schema"

export interface Interface {
  /** Create idle engine identity before publishing its durable placement. */
  readonly initialize: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    title: string
  }) => Effect.Effect<void, ConflictError>
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
  /** Interrupt the engine-owned execution; an idle Session is a no-op. */
  readonly interrupt: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<void, ConflictError>
  /** Change the engine's durable title, never the TypeScript catalog's copy. */
  readonly rename: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    title: string
  }) => Effect.Effect<void, ConflictError>
  /** Every engine-owned Session in one storage. */
  readonly sessions: (input: {
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<readonly unknown[], ConflictError>
  /**
   * Translate the engine's durable journal after an exclusive sequence into
   * product events, so a replay reconstructs what live delivery published.
   */
  readonly events: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    after: number
  }) => Effect.Effect<NativeJournalPage, ConflictError>
  /** A finite page of public durable projections; a native sequence group is indivisible. */
  readonly history: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    after: number
    limit: number
  }) => Effect.Effect<NativeJournalPage & { readonly hasMore: boolean }, ConflictError>
}

export interface NativeJournalPage {
  readonly events: readonly OpenCodeEvent[]
  readonly cursor: number
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
