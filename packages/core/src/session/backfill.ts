export * as SessionBackfill from "./backfill"

import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"
import { SessionV1Read } from "./v1-read"

const encode = Schema.encodeSync(SessionMessage.Message)

export interface Result {
  /** Sessions that had no projection and were converted from legacy-only history. */
  readonly migrated: number
  /** Sessions whose stranded legacy messages were appended to an existing projection. */
  readonly repaired: number
}

export interface Options {
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean
}

/**
 * One-time, idempotent backfill: converts legacy V1 `message` / `part` rows into
 * projected V2 `session_message` rows. Each session is migrated in its own
 * transaction. Sessions with no projection are `migrated`; sessions that already
 * have a projection but still hold legacy messages without one are `repaired`.
 */
export const backfill = (db: Database.Interface["db"], options: Options = {}) =>
  Effect.gen(function* () {
    const legacy = yield* db
      .all<{ id: string }>(sql`
        SELECT s.id AS id FROM session s
        WHERE EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM session_message x WHERE x.session_id = s.id)
      `)
      .pipe(Effect.orDie)

    const mixed = yield* db
      .all<{ id: string }>(sql`
        SELECT DISTINCT m.session_id AS id FROM message m
        WHERE NOT EXISTS (
            SELECT 1 FROM session_message x WHERE x.id = m.id AND x.session_id = m.session_id
          )
          AND EXISTS (SELECT 1 FROM session_message y WHERE y.session_id = m.session_id)
      `)
      .pipe(Effect.orDie)

    if (options.dryRun) return { migrated: legacy.length, repaired: mixed.length }

    let migrated = 0
    for (const row of legacy) {
      yield* migrateSession(db, SessionSchema.ID.make(row.id))
      migrated += 1
    }
    let repaired = 0
    for (const row of mixed) {
      yield* migrateSession(db, SessionSchema.ID.make(row.id))
      repaired += 1
    }
    return { migrated, repaired }
  })

const migrateSession = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const messageRows = yield* tx
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
          .all()
          .pipe(Effect.orDie)
        const partRows = yield* tx
          .select()
          .from(PartTable)
          .where(eq(PartTable.session_id, sessionID))
          .orderBy(asc(PartTable.time_created), asc(PartTable.id))
          .all()
          .pipe(Effect.orDie)

        const byMessage = new Map<string, SessionV1.Part[]>()
        for (const part of partRows) {
          const list = byMessage.get(part.message_id) ?? []
          list.push({
            ...(part.data as object),
            id: part.id,
            sessionID,
            messageID: part.message_id,
          } as SessionV1.Part)
          byMessage.set(part.message_id, list)
        }

        const mapped = SessionV1Read.map(
          messageRows.map((message) => ({
            info: { ...(message.data as object), id: message.id, sessionID } as SessionV1.Info,
            parts: byMessage.get(message.id) ?? [],
          })),
        )

        const existing = yield* tx
          .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const projected = new Set(existing.map((row) => row.id))
        const stranded = mapped.filter((message) => !projected.has(message.id))
        if (stranded.length === 0) return

        // `session_message.seq` is the EventV2 aggregate sequence, and future
        // events continue from the session's current maximum. Legacy messages
        // have no event, so place them strictly below every event sequence
        // (always negative) to avoid colliding with the next event and to keep
        // them identifiable as event-less legacy projection.
        let seq = -stranded.length
        for (const message of stranded) {
          const encoded = encode(message)
          const { id, type, ...data } = encoded
          yield* tx
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(id),
              session_id: sessionID,
              type,
              seq,
              time_created: DateTime.toEpochMillis(message.time.created),
              data,
            })
            .run()
            .pipe(Effect.orDie)
          seq += 1
        }
      }),
    )
    .pipe(Effect.orDie)
