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
  /** Number of sessions converted from legacy-only history. */
  readonly migrated: number
  /**
   * Sessions that hold both legacy and projected history. Backfill cannot order
   * these safely, so they are reported instead of silently skipped.
   */
  readonly mixed: ReadonlyArray<string>
}

/**
 * One-time, idempotent backfill: converts legacy V1 `message` / `part` rows into
 * projected V2 `session_message` rows for sessions that have no V2 projection
 * yet. Each session is migrated in its own transaction.
 */
export const backfill = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const sessions = yield* db
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

    let migrated = 0
    for (const row of sessions) {
      const sessionID = SessionSchema.ID.make(row.id)
      yield* db
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

            let seq = 0
            for (const message of mapped) {
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
      migrated += 1
    }
    return { migrated, mixed: mixed.map((row) => row.id) }
  })
