export * as SessionDelegationStore from "./delegation-store"

import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionDelegationTable, SessionNotificationTable, SessionTable } from "./sql"

type DB = Database.Interface["db"]
export type Info = typeof SessionDelegationTable.$inferSelect
export const resultID = (id: string) => SessionMessage.ID.make(`msg_delegation_${Hash.sha256(id)}`)

/**
 * Machine wakeups one human prompt buys: how many times notifications may start
 * or continue a drain before the Session waits for a person again. It bounds
 * self-sustaining loops — a monitor whose notices wake a turn that arms another
 * monitor — which the per-source limits (spawn caps, notification counts,
 * schedules) cannot, because each of those looks reasonable on its own.
 *
 * It is deliberately not the background-subagent limit: that bounds how much
 * work exists, this bounds how much the machine may spend on its own report.
 */
export const WAKE_BUDGET = 32

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
  yield* db
    .insert(SessionNotificationTable)
    .values({
      id: resultID(task.id),
      session_id: task.session_id,
      text: `<subagent-result session="${task.child_session_id}" task="${task.id}" status="${task.status}">\n${report}\n</subagent-result>`,
      metadata: { backgroundTask: { id: task.id, sessionID: task.child_session_id, status: task.status } },
      admitted_seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(event.data.timestamp),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/**
 * Whether this Session may be woken by a notification now: something is waiting
 * *and* the allowance to read it is not spent. Every caller that decides
 * "should the runner make another turn for this" must ask this and not whether a
 * row merely exists — a runner that sees pending work it may not promote loops
 * forever on turns that promote nothing.
 */
export const hasPromotableNotifications = Effect.fn("SessionDelegationStore.hasPromotableNotifications")(
  function* (db: DB, sessionID: SessionSchema.ID) {
    const row = yield* db
      .select({ id: SessionNotificationTable.id })
      .from(SessionNotificationTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionNotificationTable.session_id))
      .where(
        and(
          eq(SessionNotificationTable.session_id, sessionID),
          isNull(SessionNotificationTable.promoted_seq),
          gt(SessionTable.wake_allowance, 0),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  },
)

export const notificationCount = Effect.fn("SessionDelegationStore.notificationCount")(function* (
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

/**
 * Promotes at most one notification, spending one unit of the Session's wake
 * allowance. The update is the guard: it only matches a row whose allowance is
 * above zero, so two drains racing on the last unit cannot both promote. It
 * runs before the publish, so a failure after it wastes a unit rather than
 * letting a Session exceed its budget.
 */
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
  const charged = yield* db
    .update(SessionTable)
    .set({ wake_allowance: sql`${SessionTable.wake_allowance} - 1` })
    .where(and(eq(SessionTable.id, sessionID), gt(SessionTable.wake_allowance, 0)))
    .returning({ remaining: SessionTable.wake_allowance })
    .get()
    .pipe(Effect.orDie)
  if (!charged) return false
  yield* events.publish(SessionEvent.Synthetic, {
    sessionID,
    messageID: row.id,
    timestamp: DateTime.makeUnsafe(row.time_created),
    text: row.text,
    metadata: { ...row.metadata, notificationID: row.id },
  })
  return true
})

/**
 * Refills the wake allowance. Only a human prompt calls this: a background
 * subagent that could refill its parent's budget would make the budget
 * meaningless, and `SessionInput.admit` — which delegation children, messages
 * between Sessions, schedules and the runner's own loop all go through — is
 * therefore deliberately not a recharge point.
 */
export const recharge = Effect.fn("SessionDelegationStore.recharge")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .update(SessionTable)
    .set({ wake_allowance: WAKE_BUDGET })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
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
