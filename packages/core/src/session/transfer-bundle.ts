export * as SessionTransferBundle from "./transfer-bundle"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { Blob } from "../blob"
import { RuntimeOwnership } from "../runtime/ownership"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionMigration } from "./migration"
import { SessionOwnership } from "./ownership"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionStore } from "./store"
import { SessionGoal } from "./goal"
import { SystemContext } from "../system-context/index"
import { SessionTransferSnapshots } from "./transfer-snapshots"
import {
  SessionDelegationTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionNotificationTable,
  SessionTable,
  SessionToolDispatchTable,
  TodoTable,
} from "./sql"

export const MAX_BYTES = 64 * 1024 * 1024

export const Bundle = Schema.Struct({
  format: Schema.Literal("miao.session.transfer.v1"),
  source: Schema.Struct({
    engine: Schema.Literal("ts"),
    storage: AbsolutePath,
    sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1)),
  }),
  session: SessionSchema.Info,
  source_state: Schema.Record(Schema.String, Schema.Unknown),
  context_epoch: Schema.optional(
    Schema.Struct({
      session_id: SessionSchema.ID,
      baseline: Schema.String,
      snapshot: SystemContext.Snapshot,
      baseline_seq: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1)),
    }),
  ),
  operational: Schema.Struct({
    goal: Schema.optional(SessionGoal.Info),
    todos: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    delegations: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    notifications: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    tool_dispatches: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  timeline: Schema.Array(SessionMessage.Message),
  context_ids: Schema.Array(SessionMessage.ID),
  events: Schema.Array(
    Schema.Struct({
      id: EventV2.ID,
      seq: Schema.Number,
      type: Schema.String,
      data: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  artifacts: Schema.Array(Schema.Struct({ hash: Schema.String, base64: Schema.String })),
  snapshots: Schema.optional(Schema.Array(SessionTransferSnapshots.Manifest)),
})
export type Bundle = typeof Bundle.Type

export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()("SessionTransfer.Unsupported", {
  sessionID: SessionSchema.ID,
  reason: Schema.String,
}) {}

/** Capture and freeze under the source's actual lifetime lease. The canonical
 * timeline and original event payloads are retained, not reconstructed from a
 * text-only provider transcript. The payload is committed with the freeze so a
 * new operator process can resume without re-reading changed external state. */
export const prepare = Effect.fn("SessionTransferBundle.prepare")(function* (input: {
  id: string
  sessionID: SessionSchema.ID
  target: Extract<SessionEnginePlacement.Placement, { engine: "rust" }>
  /** The target validates the exact payload while the source lease is held,
   * before its durable freeze. No target execution authority is granted here. */
  validate?: (input: { serialized: string; digest: string }) => Effect.Effect<void, Error>
}) {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const blobs = yield* Blob.Service
  const storage = yield* Effect.promise(() => RuntimeOwnership.canonicalStorage(database.storage))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* SessionOwnership.exclusive(storage, input.sessionID)
      const existing = yield* SessionMigration.find(database.db, input.id)
      if (existing) {
        if (!existing.bundle)
          return yield* new Unsupported({
            sessionID: input.sessionID,
            reason: "Transition has no semantic payload; abort it before starting a new transfer",
          })
        const bundle = yield* decode(existing.bundle).pipe(
          Effect.mapError(
            () => new Unsupported({ sessionID: input.sessionID, reason: "Stored semantic payload is invalid" }),
          ),
        )
        if (input.validate) yield* input.validate({ serialized: existing.bundle, digest: existing.bundle_sha256 })
        const frozen = yield* SessionMigration.freeze(database.db, {
          ...input,
          bundle: existing.bundle,
          bundleSHA256: existing.bundle_sha256,
          sourceSeq: bundle.source.sequence,
        })
        return { frozen, bundle, serialized: existing.bundle, digest: existing.bundle_sha256 }
      }
      const captured = yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const placement = yield* SessionEnginePlacement.find(database.db, input.sessionID)
            const session = yield* store.get(input.sessionID)
            const state = yield* store.historyState(input.sessionID)
            if (!session || placement?.engine === "rust" || (state !== "empty" && state !== "projected"))
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "Source must be an existing, fully projected TypeScript Session",
              })
            if (
              session.location.directory !== input.target.location.directory ||
              session.location.workspaceID !== input.target.location.workspaceID
            )
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "An engine transfer cannot silently relocate the Session",
              })
            if (session.revert)
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "Commit or clear the staged revert before transferring",
              })
            const pending = yield* database.db
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(and(eq(SessionInputTable.session_id, input.sessionID), isNull(SessionInputTable.promoted_seq)))
              .get()
              .pipe(Effect.orDie)
            const dispatch = yield* database.db
              .select({ id: SessionToolDispatchTable.call_id })
              .from(SessionToolDispatchTable)
              .where(
                and(
                  eq(SessionToolDispatchTable.session_id, input.sessionID),
                  inArray(SessionToolDispatchTable.status, ["planned", "dispatched", "unknown"]),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            const delegation = yield* database.db
              .select({ id: SessionDelegationTable.id })
              .from(SessionDelegationTable)
              .where(
                and(
                  eq(SessionDelegationTable.session_id, input.sessionID),
                  eq(SessionDelegationTable.status, "running"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            const notification = yield* database.db
              .select({ id: SessionNotificationTable.id })
              .from(SessionNotificationTable)
              .where(
                and(
                  eq(SessionNotificationTable.session_id, input.sessionID),
                  isNull(SessionNotificationTable.promoted_seq),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (pending || dispatch || delegation || notification)
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "Settle pending inputs, tool attempts, notifications and child delegations before transferring",
              })
            const timeline = yield* store.timeline(input.sessionID)
            const unfinished = timeline.some(
              (message) =>
                message.type === "assistant" &&
                ((!message.time.completed && !message.finish && !message.error) ||
                  message.content.some(
                    (part) =>
                      part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
                  )),
            )
            if (unfinished)
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "Source contains unfinished model or tool work",
              })
            const context = yield* store.context(input.sessionID)
            const source = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!source)
              return yield* new Unsupported({ sessionID: input.sessionID, reason: "Source identity disappeared" })
            if (source.permission?.length)
              return yield* new Unsupported({
                sessionID: input.sessionID,
                reason: "Session-specific permission rules require an explicit target authority mapping",
              })
            const context_epoch = yield* database.db
              .select()
              .from(SessionContextEpochTable)
              .where(eq(SessionContextEpochTable.session_id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            const sequence = yield* EventV2.latestSequence(database.db, input.sessionID)
            if (context_epoch) {
              yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(context_epoch.snapshot)
              if (context_epoch.baseline_seq > sequence)
                return yield* new Unsupported({
                  sessionID: input.sessionID,
                  reason: "Context Epoch baseline points beyond the durable source history",
                })
            }
            const operational = {
              goal: yield* SessionGoal.current(database.db, input.sessionID),
              todos: yield* database.db
                .select()
                .from(TodoTable)
                .where(eq(TodoTable.session_id, input.sessionID))
                .orderBy(asc(TodoTable.position))
                .all()
                .pipe(Effect.orDie),
              delegations: yield* database.db
                .select()
                .from(SessionDelegationTable)
                .where(eq(SessionDelegationTable.session_id, input.sessionID))
                .orderBy(asc(SessionDelegationTable.id))
                .all()
                .pipe(Effect.orDie),
              notifications: yield* database.db
                .select()
                .from(SessionNotificationTable)
                .where(eq(SessionNotificationTable.session_id, input.sessionID))
                .orderBy(asc(SessionNotificationTable.admitted_seq))
                .all()
                .pipe(Effect.orDie),
              tool_dispatches: yield* database.db
                .select()
                .from(SessionToolDispatchTable)
                .where(eq(SessionToolDispatchTable.session_id, input.sessionID))
                .orderBy(asc(SessionToolDispatchTable.assistant_message_id), asc(SessionToolDispatchTable.call_id))
                .all()
                .pipe(Effect.orDie),
            }
            const events = yield* database.db
              .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, input.sessionID))
              .orderBy(asc(EventTable.seq))
              .all()
              .pipe(Effect.orDie)
            return {
              session,
              timeline,
              context_ids: context.map((message) => message.id),
              source_state: source,
              context_epoch,
              operational,
              events,
              source: {
                engine: "ts" as const,
                storage: AbsolutePath.make(storage),
                sequence,
              },
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const hashes = [
        ...new Set(
          blobHashes({
            timeline: Schema.encodeSync(Schema.Array(SessionMessage.Message))(captured.timeline),
            events: captured.events,
            operational: captured.operational,
            context_epoch: captured.context_epoch,
          }),
        ),
      ].sort()
      if (hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
        return yield* new Unsupported({ sessionID: input.sessionID, reason: "Malformed attachment content reference" })
      const base = Bundle.make({ format: "miao.session.transfer.v1", ...captured, artifacts: [], snapshots: [] })
      const initial: { artifacts: Bundle["artifacts"]; bytes: number } = {
        artifacts: [],
        bytes: Buffer.byteLength(JSON.stringify(Schema.encodeSync(Bundle)(base))),
      }
      if (initial.bytes > MAX_BYTES)
        return yield* new Unsupported({
          sessionID: input.sessionID,
          reason: "Semantic payload exceeds the transfer size limit",
        })
      const collected = yield* hashes.reduce<Effect.Effect<typeof initial, Unsupported | Blob.StorageError>>(
        (effect, hash) =>
          effect.pipe(
            Effect.flatMap((state) =>
              Effect.gen(function* () {
                // Reserve JSON overhead, and bound each read by the remaining aggregate
                // budget before materializing or base64-encoding another attachment.
                const remaining = Math.floor((MAX_BYTES - state.bytes - 128) / 4) * 3
                if (remaining < 0)
                  return yield* new Unsupported({
                    sessionID: input.sessionID,
                    reason: "Attachments exceed the transfer size limit",
                  })
                const bytes = yield* blobs.get(hash, remaining)
                if (!bytes || Hash.sha256(bytes) !== hash)
                  return yield* new Unsupported({
                    sessionID: input.sessionID,
                    reason: "Referenced attachment is missing or failed its content hash check",
                  })
                const base64 = Buffer.from(bytes).toString("base64")
                return { artifacts: [...state.artifacts, { hash, base64 }], bytes: state.bytes + base64.length + 128 }
              }),
            ),
          ),
        Effect.succeed(initial),
      )
      const portable = yield* SessionTransferSnapshots.capture({
        timeline: captured.timeline,
        artifacts: collected.artifacts,
        bytes: collected.bytes,
        maximumBytes: MAX_BYTES,
      }).pipe(Effect.mapError((cause) => new Unsupported({ sessionID: input.sessionID, reason: String(cause) })))
      const bundle = Bundle.make({ ...base, ...portable })
      const serialized = JSON.stringify(Schema.encodeSync(Bundle)(bundle))
      if (Buffer.byteLength(serialized) > MAX_BYTES)
        return yield* new Unsupported({
          sessionID: input.sessionID,
          reason: "Semantic payload exceeds the transfer size limit",
        })
      const digest = Hash.sha256(serialized)
      if (input.validate) yield* input.validate({ serialized, digest })
      const frozen = yield* SessionMigration.freeze(database.db, {
        ...input,
        bundle: serialized,
        bundleSHA256: digest,
        sourceSeq: bundle.source.sequence,
      })
      return { frozen, bundle, serialized, digest }
    }),
  )
})

export const decode = (serialized: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(serialized).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Bundle)),
  )

// Attachment references may also occur in settled tool output or retained
// metadata. Preserve those bytes too, without treating literal text as a URI.
function blobHashes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(blobHashes)
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => {
    if ((key === "uri" || key === "url") && typeof item === "string" && Blob.isRef(item)) {
      const hash = Blob.hashOf(item)
      if (hash && /^[a-f0-9]{64}$/.test(hash)) return [hash]
      return ["invalid-content-reference"]
    }
    return blobHashes(item)
  })
}
