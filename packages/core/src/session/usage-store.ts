export * as SessionUsageStore from "./usage-store"

import { and, eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionTable, SessionToolUsageTable, SessionTurnUsageTable } from "./sql"

type DB = Database.Interface["db"]

/**
 * `Step.Ended` events settled before the model was recorded on the event carry
 * no model; fall back to the Session's selected model, and drop the row only
 * when even the Session cannot attribute one.
 */
const resolveModel = Effect.fn("SessionUsageStore.resolveModel")(function* (db: DB, sessionID: SessionSchema.ID) {
  const session = yield* db
    .select({ model: SessionTable.model })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return session?.model
})

export const projectStepEnded = Effect.fn("SessionUsageStore.projectStepEnded")(function* (
  db: DB,
  event: SessionEvent.Step.Ended,
) {
  const model = event.data.model ?? (yield* resolveModel(db, event.data.sessionID))
  if (!model) return
  yield* db
    .insert(SessionTurnUsageTable)
    .values({
      event_id: event.id,
      session_id: event.data.sessionID,
      assistant_message_id: event.data.assistantMessageID,
      model_provider: model.providerID,
      model_id: model.id,
      variant: model.variant,
      finish: event.data.finish,
      cost: event.data.cost,
      tokens_input: event.data.tokens.input,
      tokens_output: event.data.tokens.output,
      tokens_reasoning: event.data.tokens.reasoning,
      tokens_cache_read: event.data.tokens.cache.read,
      tokens_cache_write: event.data.tokens.cache.write,
      ttft_ms: event.data.ttft === undefined ? undefined : Math.round(event.data.ttft),
      time_created: DateTime.toEpochMillis(event.data.timestamp),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const projectToolCalled = Effect.fn("SessionUsageStore.projectToolCalled")(function* (
  db: DB,
  event: SessionEvent.Tool.Called,
) {
  yield* db
    .insert(SessionToolUsageTable)
    .values({
      session_id: event.data.sessionID,
      call_id: event.data.callID,
      assistant_message_id: event.data.assistantMessageID,
      tool: event.data.tool,
      status: "running",
      time_called: DateTime.toEpochMillis(event.data.timestamp),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const projectToolSettled = Effect.fn("SessionUsageStore.projectToolSettled")(function* (
  db: DB,
  event: SessionEvent.Tool.Success | SessionEvent.Tool.Failed,
  status: "success" | "failed",
) {
  yield* db
    .update(SessionToolUsageTable)
    .set({ status, time_settled: DateTime.toEpochMillis(event.data.timestamp) })
    .where(
      and(
        eq(SessionToolUsageTable.session_id, event.data.sessionID),
        eq(SessionToolUsageTable.call_id, event.data.callID),
        eq(SessionToolUsageTable.status, "running"),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})
