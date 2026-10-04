export * as SessionRetention from "./retention"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

type DatabaseService = Database.Interface["db"]

export type Plan = {
  readonly sessions: number
  readonly events: number
  readonly bytes: number
}

/**
 * Reports durable events a snapshot-then-truncate retention could drop: events
 * at or before each session's latest compaction baseline, whose content is
 * already summarized in the projection.
 *
 * Report-only. Deletion is not enabled because `V2Session.diff`, the durable
 * event stream (`V2Session.events`), and `V2Session.history` still read the event
 * log; pruning it would break them until they read the projection instead. See
 * `specs/storage/session-storage-hardening.md`.
 */
export const plan = (db: DatabaseService) =>
  Effect.gen(function* () {
    const row = yield* db
      .get<{ sessions: number; events: number; bytes: number }>(sql`
        SELECT COUNT(DISTINCT e.aggregate_id) AS sessions,
               COUNT(*) AS events,
               COALESCE(SUM(LENGTH(e.data)), 0) AS bytes
        FROM event e
        WHERE e.seq < (
          SELECT MAX(m.seq) FROM session_message m
          WHERE m.session_id = e.aggregate_id AND m.type = 'compaction'
        )
      `)
      .pipe(Effect.orDie)
    return {
      sessions: Number(row?.sessions ?? 0),
      events: Number(row?.events ?? 0),
      bytes: Number(row?.bytes ?? 0),
    } satisfies Plan
  })
