export * as SessionUsageStore from "./usage-store"

import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionTable, SessionToolUsageTable, SessionTurnUsageTable } from "./sql"

type DB = Database.Interface["db"]

export type Usage = Pick<SessionEvent.Step.Ended["data"], "cost" | "tokens">

export const history = Effect.fn("SessionUsageStore.history")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  input: { before?: string; limit?: number } = {},
) {
  const anchor =
    input.before === undefined
      ? undefined
      : yield* db
          .select({
            time: SessionTurnUsageTable.time_created,
            id: SessionTurnUsageTable.event_id,
          })
          .from(SessionTurnUsageTable)
          .where(and(eq(SessionTurnUsageTable.session_id, sessionID), eq(SessionTurnUsageTable.event_id, input.before)))
          .get()
          .pipe(Effect.orDie)
  if (input.before !== undefined && !anchor) return undefined
  const limit = Math.max(1, Math.min(200, input.limit ?? 100))
  const rows = yield* db
    .select()
    .from(SessionTurnUsageTable)
    .where(
      and(
        eq(SessionTurnUsageTable.session_id, sessionID),
        anchor
          ? or(
              lt(SessionTurnUsageTable.time_created, anchor.time),
              and(eq(SessionTurnUsageTable.time_created, anchor.time), lt(SessionTurnUsageTable.event_id, anchor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(SessionTurnUsageTable.time_created), desc(SessionTurnUsageTable.event_id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, limit)
  return {
    items: page.toReversed().map((row) => ({
      id: row.event_id,
      messageID: row.assistant_message_id,
      model: {
        providerID: ProviderV2.ID.make(row.model_provider),
        id: ModelV2.ID.make(row.model_id),
        variant: row.variant === null ? undefined : ModelV2.VariantID.make(row.variant),
      },
      time: row.time_created,
      finish: row.finish,
      cost: row.cost,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
      },
      ttftMs: row.ttft_ms ?? undefined,
    })),
    next: rows.length > limit ? page.at(-1)?.event_id : undefined,
  }
})

export function applyUsage(db: DB, sessionID: SessionSchema.ID, value: Usage, sign = 1) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

/**
 * Apply a session's step usage to the session and every ancestor session, so a
 * parent's `cost`/tokens reflect its subagents. Each descendant step is applied
 * once per ancestor, which sums the subtree without double counting.
 */
const MAX_ANCESTORS = 64
export function applyUsageWithAncestors(db: DB, sessionID: SessionSchema.ID, value: Usage, sign = 1) {
  return Effect.gen(function* () {
    yield* applyUsage(db, sessionID, value, sign)
    let current = sessionID
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
      const row = yield* db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, current))
        .get()
        .pipe(Effect.orDie)
      const parentID = row?.parentID
      if (!parentID) break
      yield* applyUsage(db, parentID, value, sign)
      current = parentID
    }
  })
}

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
  if (!model) return false
  const inserted = yield* db
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
    .returning({ id: SessionTurnUsageTable.event_id })
    .get()
    .pipe(Effect.orDie)
  return inserted !== undefined
})

// Native steps do not enter the TS message journal. Keep their fact and
// aggregate updates atomic, using the stable event ID as the replay guard.
export const projectNativeStepEnded = Effect.fn("SessionUsageStore.projectNativeStepEnded")(function* (
  db: DB,
  event: SessionEvent.Step.Ended,
) {
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const inserted = yield* projectStepEnded(db, event)
        if (!inserted) return
        yield* applyUsageWithAncestors(db, event.data.sessionID, event.data)
      }),
    )
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

/**
 * Lifetime per-model usage and tool-call counts for one Session, in one pass
 * each over the two indexed fact tables. `undefined` when nothing has been
 * recorded, so a caller can leave the field absent instead of shipping an
 * empty block.
 */
export const summary = Effect.fn("SessionUsageStore.summary")(function* (db: DB, sessionID: SessionSchema.ID) {
  const turns = yield* db
    .select({
      providerID: SessionTurnUsageTable.model_provider,
      id: SessionTurnUsageTable.model_id,
      variant: SessionTurnUsageTable.variant,
      turns: sql<number>`count(*)`,
      cost: sql<number>`coalesce(sum(cost), 0)`,
      input: sql<number>`coalesce(sum(tokens_input), 0)`,
      output: sql<number>`coalesce(sum(tokens_output), 0)`,
      reasoning: sql<number>`coalesce(sum(tokens_reasoning), 0)`,
      cacheRead: sql<number>`coalesce(sum(tokens_cache_read), 0)`,
      cacheWrite: sql<number>`coalesce(sum(tokens_cache_write), 0)`,
      lastTurnAt: sql<number>`max(time_created)`,
    })
    .from(SessionTurnUsageTable)
    .where(eq(SessionTurnUsageTable.session_id, sessionID))
    .groupBy(SessionTurnUsageTable.model_provider, SessionTurnUsageTable.model_id, SessionTurnUsageTable.variant)
    .all()
    .pipe(Effect.orDie)
  const tools = yield* db
    .select({
      calls: sql<number>`count(*)`,
      failures: sql<number>`coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)`,
    })
    .from(SessionToolUsageTable)
    .where(eq(SessionToolUsageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const calls = tools?.calls ?? 0
  if (turns.length === 0 && calls === 0) return undefined
  const models = turns
    .map((row) => ({
      providerID: ProviderV2.ID.make(row.providerID),
      id: ModelV2.ID.make(row.id),
      ...(row.variant === null ? {} : { variant: row.variant }),
      turns: row.turns,
      cost: row.cost,
      tokens: {
        input: row.input,
        output: row.output,
        reasoning: row.reasoning,
        cache: { read: row.cacheRead, write: row.cacheWrite },
      },
      lastTurnAt: DateTime.makeUnsafe(row.lastTurnAt),
    }))
    .toSorted((a, b) => DateTime.toEpochMillis(b.lastTurnAt) - DateTime.toEpochMillis(a.lastTurnAt))
  return {
    turns: models.reduce((total, model) => total + model.turns, 0),
    tools: { calls, failures: tools?.failures ?? 0 },
    models,
  }
})
