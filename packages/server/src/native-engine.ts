import type { Agent } from "@miao/schema/agent"
import { Context, Effect } from "effect"
import type { OpenCodeEvent } from "@miao/protocol/groups/event"
import type { Permission } from "@miao/schema/permission"
import type { Question } from "@miao/schema/question"
import type { ConflictError } from "@miao/protocol/errors"
import type { Location } from "@miao/schema/location"
import type { SessionExecution } from "@miao/schema/session-execution"
import type { SessionID } from "@miao/schema/session-id"
import type { SessionInput } from "@miao/schema/session-input"
import type { SessionMessage } from "@miao/schema/session-message"
import type { SessionInfo } from "@miao/schema/session-info"
import type { Model } from "@miao/schema/model"
import type { SessionModelRoute } from "@miao/schema/session-model-route"
import type { SessionRecovery } from "@miao/schema/session-recovery"
import type { PromptInput } from "@miao/schema/prompt-input"
import type { AbsolutePath } from "@miao/core/schema"

export interface Interface {
  readonly selectAgent: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    agent: Agent.Info
  }) => Effect.Effect<void, ConflictError>

  readonly modelRoutes: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<readonly SessionModelRoute.Info[], ConflictError>
  readonly selectModel: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    model: Model.Ref
  }) => Effect.Effect<void, ConflictError>
  readonly recoveries: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    after?: string
  }) => Effect.Effect<SessionRecovery.Page, ConflictError>
  readonly resolveRecovery: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    callID: string
    operationID: string
    decision: SessionRecovery.Decision
    resume?: boolean
  }) => Effect.Effect<SessionRecovery.Resolution, ConflictError>
  /** Create idle engine identity before publishing its durable placement. */
  readonly initialize: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    title: string
  }) => Effect.Effect<void, ConflictError>
  /**
   * Drop one durably admitted input before the engine promotes it. The engine
   * keeps the cancelled admission as durable evidence, so an exact retry cannot
   * resurrect the prompt; an unknown or already promoted input reports `false`.
   */
  readonly cancelInput: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    inputID: SessionMessage.ID
  }) => Effect.Effect<boolean, ConflictError>
  /**
   * Ask the engine for one compaction at its next settled assistant boundary,
   * even when automatic compaction is not configured or under its threshold.
   * The request is durable and idempotent.
   */
  readonly requestCompact: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<void, ConflictError>
  /**
   * Set or clear the engine's archive timestamp. Archiving is a catalog fact
   * that survives in the snapshot, so the product projection can filter on it.
   */
  readonly archive: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    archived: boolean
  }) => Effect.Effect<void, ConflictError>
  /**
   * Delete the engine's copy of a Session: its conversation, inbox, runs,
   * approvals, background work and schedules. Children keep their Sessions and
   * lose only their lineage edge, matching the product's rule that removing a
   * Session does not delete its forks.
   */
  readonly remove: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
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
    prompt: PromptInput.Prompt
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
  /**
   * The engine's usage report: billed turns, per-identity lineage, tool
   * counts, and timing. Pricing is a product fact, so the raw report is
   * projected by the caller through the model catalog.
   */
  readonly usage: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<Readonly<Record<string, unknown>>, ConflictError>
  /** Captured, read-only product transcript from native storage. */
  readonly transcript: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    selected: boolean
  }) => Effect.Effect<readonly SessionMessage.Message[], ConflictError>
  readonly interruptIf: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    executionID: SessionExecution.ID
  }) => Effect.Effect<boolean, ConflictError>
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
  readonly permissions: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<readonly Permission.Request[], ConflictError>
  readonly replyPermission: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    requestID: Permission.ID
    reply: Permission.Reply
  }) => Effect.Effect<void, ConflictError>
  readonly questions: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
  }) => Effect.Effect<readonly Question.Request[], ConflictError>
  readonly replyQuestion: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    requestID: Question.ID
    answers: readonly (readonly string[])[]
  }) => Effect.Effect<void, ConflictError>
  readonly rejectQuestion: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    requestID: Question.ID
  }) => Effect.Effect<void, ConflictError>
  readonly fork: (input: {
    sessionID: SessionID
    storage: AbsolutePath
    location: Location.Ref
    targetSessionID: SessionID
    messageID?: SessionMessage.ID
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
