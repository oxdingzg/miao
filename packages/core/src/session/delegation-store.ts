export * as SessionDelegationStore from "./delegation-store"

import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionDelegationTable, SessionNotificationTable } from "./sql"

type DB = Database.Interface["db"]
export type Info = typeof SessionDelegationTable.$inferSelect
export const resultID = (id: string) => SessionMessage.ID.make(`msg_delegation_${Hash.sha256(id)}`)

/**
 * Identified by the reporting event's own sequence, so a replayed projection
 * inserts the same row at most once.
 */
export const progressID = (id: string, seq: number) =>
  SessionMessage.ID.make(`msg_progress_${Hash.sha256(`${id}:${seq}`)}`)

/**
 * One pending notification for a Session. A notification is durable work the
 * machine owes the model, never a user prompt: promotion decides only when the
 * model reads it, not whether it is kept.
 */
const insertNotification = (
  db: DB,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly id: SessionMessage.ID
    readonly text: string
    readonly metadata: Record<string, unknown>
    readonly admittedSeq: number
    readonly timeCreated: number
  },
) =>
  db
    .insert(SessionNotificationTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      text: input.text,
      metadata: input.metadata,
      admitted_seq: input.admittedSeq,
      time_created: input.timeCreated,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

/**
 * Whether a notification is a subagent progress note. Metadata is the only
 * place a notification carries its kind, so this reads into the JSON column
 * rather than adding a column for one flag.
 */
const progressFlag = sql`json_extract(${SessionNotificationTable.metadata}, '$.backgroundTask.progress')`

export const get = Effect.fn("SessionDelegationStore.get")(function* (db: DB, sessionID: SessionSchema.ID, id: string) {
  return yield* db
    .select()
    .from(SessionDelegationTable)
    .where(and(eq(SessionDelegationTable.session_id, sessionID), eq(SessionDelegationTable.id, id)))
    .get()
    .pipe(Effect.orDie)
})

export const list = Effect.fn("SessionDelegationStore.list")(function* (db: DB, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionDelegationTable)
    .where(eq(SessionDelegationTable.session_id, sessionID))
    .orderBy(desc(sql`${SessionDelegationTable.status} = 'running'`), desc(SessionDelegationTable.time_created))
    .limit(50)
    .all()
    .pipe(Effect.orDie)
})

export const activeCount = Effect.fn("SessionDelegationStore.activeCount")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ value: count() })
    .from(SessionDelegationTable)
    .where(and(eq(SessionDelegationTable.session_id, sessionID), eq(SessionDelegationTable.status, "running")))
    .get()
    .pipe(Effect.orDie)
  return row?.value ?? 0
})

export const projectStarted = Effect.fn("SessionDelegationStore.projectStarted")(function* (
  db: DB,
  event: SessionEvent.DelegationStarted,
) {
  yield* db
    .insert(SessionDelegationTable)
    .values({
      id: event.data.id,
      session_id: event.data.sessionID,
      child_session_id: event.data.childSessionID,
      prompt_message_id: event.data.promptMessageID,
      agent: event.data.agent,
      prompt: event.data.prompt,
      description: event.data.description,
      owner: event.data.owner,
      status: "running",
      time_created: DateTime.toEpochMillis(event.data.timestamp),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const projectEnded = Effect.fn("SessionDelegationStore.projectEnded")(function* (
  db: DB,
  event: SessionEvent.DelegationEnded,
) {
  if (!event.durable) return yield* Effect.die("Delegation result requires a durable sequence")
  const task = yield* db
    .update(SessionDelegationTable)
    .set({ status: event.data.status, result: event.data.text })
    .where(
      and(
        eq(SessionDelegationTable.id, event.data.id),
        eq(SessionDelegationTable.session_id, event.data.sessionID),
        eq(SessionDelegationTable.status, "running"),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!task) return
  // Preserve the complete report in the ticket/child transcript. Forward a
  // bounded verbatim prefix, never an LLM paraphrase, into the parent's context.
  const bytes = Buffer.from(event.data.text)
  const report =
    bytes.length <= 64 * 1024
      ? event.data.text
      : `${new TextDecoder().decode(bytes.subarray(0, 64 * 1024), { stream: true })}\n[Report truncated; use task_result for the complete report.]`
  yield* insertNotification(db, {
    sessionID: task.session_id,
    id: resultID(task.id),
    text: `<subagent-result session="${task.child_session_id}" task="${task.id}" status="${task.status}">\n${report}\n</subagent-result>`,
    metadata: { backgroundTask: { id: task.id, sessionID: task.child_session_id, status: task.status } },
    admittedSeq: event.durable.seq,
    timeCreated: DateTime.toEpochMillis(event.data.timestamp),
  })
})

/**
 * Projects a running subagent's interim note. It is wrapped in its own tag and
 * flagged in metadata so the parent can tell a progress note from the result,
 * which is the one that settles the delegation.
 */
export const projectReported = Effect.fn("SessionDelegationStore.projectReported")(function* (
  db: DB,
  event: SessionEvent.DelegationReported,
) {
  if (!event.durable) return yield* Effect.die("Delegation report requires a durable sequence")
  const task = yield* db
    .select()
    .from(SessionDelegationTable)
    .where(
      and(eq(SessionDelegationTable.id, event.data.id), eq(SessionDelegationTable.session_id, event.data.sessionID)),
    )
    .get()
    .pipe(Effect.orDie)
  if (!task || task.status !== "running") return
  yield* insertNotification(db, {
    sessionID: task.session_id,
    id: progressID(task.id, event.durable.seq),
    text: `<subagent-progress session="${task.child_session_id}" task="${task.id}">\n${event.data.text}\n</subagent-progress>`,
    metadata: { backgroundTask: { id: task.id, sessionID: task.child_session_id, progress: true } },
    admittedSeq: event.durable.seq,
    timeCreated: DateTime.toEpochMillis(event.data.timestamp),
  })
})

/** The running background delegation that owns this child Session, if any. */
export const runningForChild = Effect.fn("SessionDelegationStore.runningForChild")(function* (
  db: DB,
  childSessionID: SessionSchema.ID,
) {
  return yield* db
    .select()
    .from(SessionDelegationTable)
    .where(
      and(
        eq(SessionDelegationTable.child_session_id, childSessionID),
        eq(SessionDelegationTable.status, "running"),
      ),
    )
    .orderBy(desc(SessionDelegationTable.time_created))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

/** Progress notes one delegation has sent, whether or not the parent read them. */
export const progressCount = Effect.fn("SessionDelegationStore.progressCount")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  id: string,
) {
  const row = yield* db
    .select({ value: count() })
    .from(SessionNotificationTable)
    .where(
      and(
        eq(SessionNotificationTable.session_id, sessionID),
        eq(sql`json_extract(${SessionNotificationTable.metadata}, '$.backgroundTask.id')`, id),
        sql`${progressFlag} IS 1`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  return row?.value ?? 0
})

/** Un-promoted notifications of every kind waiting for a Session. */
export const pendingCount = Effect.fn("SessionDelegationStore.pendingCount")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ value: count() })
    .from(SessionNotificationTable)
    .where(and(eq(SessionNotificationTable.session_id, sessionID), isNull(SessionNotificationTable.promoted_seq)))
    .get()
    .pipe(Effect.orDie)
  return row?.value ?? 0
})

export const hasNotifications = Effect.fn("SessionDelegationStore.hasNotifications")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ id: SessionNotificationTable.id })
    .from(SessionNotificationTable)
    .where(and(eq(SessionNotificationTable.session_id, sessionID), isNull(SessionNotificationTable.promoted_seq)))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

/**
 * Unread delegation outcomes. Progress notes are excluded: they are bounded per
 * delegation, so counting them would let a chatty subagent stop its parent from
 * starting any new work.
 */
export const notificationCount = Effect.fn("SessionDelegationStore.notificationCount")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ value: count() })
    .from(SessionNotificationTable)
    .where(
      and(
        eq(SessionNotificationTable.session_id, sessionID),
        isNull(SessionNotificationTable.promoted_seq),
        sql`COALESCE(${progressFlag}, 0) != 1`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  return row?.value ?? 0
})

export const promoteNext = Effect.fn("SessionDelegationStore.promoteNext")(function* (
  db: DB,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionNotificationTable)
    .where(and(eq(SessionNotificationTable.session_id, sessionID), isNull(SessionNotificationTable.promoted_seq)))
    .orderBy(asc(SessionNotificationTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return false
  yield* events.publish(SessionEvent.Synthetic, {
    sessionID,
    messageID: row.id,
    timestamp: DateTime.makeUnsafe(row.time_created),
    text: row.text,
    metadata: { ...row.metadata, notificationID: row.id },
  })
  return true
})

export const projectNotification = Effect.fn("SessionDelegationStore.projectNotification")(function* (
  db: DB,
  event: SessionEvent.Synthetic,
) {
  if (event.data.metadata?.notificationID !== event.data.messageID) return
  if (!event.durable) return yield* Effect.die("Notification promotion requires a durable sequence")
  yield* db
    .update(SessionNotificationTable)
    .set({ promoted_seq: event.durable.seq })
    .where(
      and(
        eq(SessionNotificationTable.id, event.data.messageID),
        eq(SessionNotificationTable.session_id, event.data.sessionID),
        isNull(SessionNotificationTable.promoted_seq),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

/** Reconcile results only; never restart a child provider turn after a crash. */
export const recover = Effect.fn("SessionDelegationStore.recover")(function* (
  db: DB,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  owner: string,
  isAlive: (owner: string) => boolean,
) {
  const tasks = yield* db
    .select()
    .from(SessionDelegationTable)
    .where(and(eq(SessionDelegationTable.session_id, sessionID), eq(SessionDelegationTable.status, "running")))
    .all()
    .pipe(Effect.orDie)
  for (const task of tasks) {
    if (task.owner === owner || isAlive(task.owner)) continue
    yield* events.publish(SessionEvent.DelegationEnded, {
      sessionID,
      id: task.id,
      timestamp: yield* DateTime.now,
      status: "interrupted",
      text: `Background task lost its runtime owner before durable completion. Its outcome is unknown. Inspect child Session ${task.child_session_id} before retrying; it was not automatically restarted.`,
    })
  }
})
