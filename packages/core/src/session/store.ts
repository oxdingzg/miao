export * as SessionStore from "./store"

import { asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { SessionLegacyTables } from "./legacy-tables"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionV1 } from "../v1/session"
import { SessionV1Read } from "./v1-read"
import { fromRow } from "./info"

/**
 * Storage provenance of a session's history:
 * - `empty`: nothing recorded yet.
 * - `legacy`: only V1 `message` / `part` rows, never projected.
 * - `projected`: every legacy message (if any) has a V2 projection.
 * - `mixed`: V2 rows exist but some legacy message has no projection, so the
 *   two histories cannot be ordered safely. Should not happen; a backfill
 *   either never ran or was interrupted.
 */
export type HistoryState = "empty" | "legacy" | "projected" | "mixed"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  /**
   * Every projected message of the session in sequence order, including history
   * behind the latest compaction that `context` leaves out. Legacy V1 rows that
   * were never projected are not included.
   */
  readonly timeline: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly historyState: (sessionID: SessionSchema.ID) => Effect.Effect<HistoryState>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    const loadV1 = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (!(yield* SessionLegacyTables.present(db))) return undefined
      const session = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const messageRows = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .all()
        .pipe(Effect.orDie)
      if (messageRows.length === 0) return undefined
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.session_id, sessionID))
        .orderBy(asc(PartTable.time_created), asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
      const byMessage = new Map<string, SessionV1.Part[]>()
      for (const row of partRows) {
        const list = byMessage.get(row.message_id) ?? []
        list.push({ ...(row.data as object), id: row.id, sessionID, messageID: row.message_id } as SessionV1.Part)
        byMessage.set(row.message_id, list)
      }
      return {
        directory: session?.directory,
        messages: messageRows.map((row) => ({
          info: { ...(row.data as object), id: row.id, sessionID } as SessionV1.Info,
          parts: byMessage.get(row.id) ?? [],
        })),
      }
    })

    const historyState: Interface["historyState"] = Effect.fn("SessionStore.historyState")(function* (sessionID) {
      const retainsLegacy = yield* SessionLegacyTables.present(db)
      const legacy = yield* retainsLegacy
        ? db
            .select({ id: MessageTable.id })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, sessionID))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
        : Effect.succeed(undefined)
      const projected = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (legacy === undefined) return projected === undefined ? "empty" : "projected"
      if (projected === undefined) return "legacy"
      // Both exist: a completed backfill preserves legacy message ids, so only
      // a legacy message missing from the projection makes the state unsafe.
      const stranded = yield* db
        .get(sql`
          SELECT 1 AS present FROM message m
          WHERE m.session_id = ${sessionID}
            AND NOT EXISTS (
              SELECT 1 FROM session_message x WHERE x.id = m.id AND x.session_id = m.session_id
            )
          LIMIT 1
        `)
        .pipe(Effect.orDie)
      return stranded === undefined ? "projected" : "mixed"
    })

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        const projected = yield* SessionHistory.load(db, sessionID)
        const legacy = yield* loadV1(sessionID)
        if (legacy === undefined) return projected
        const mapped = SessionV1Read.map(legacy.messages, { directory: legacy.directory })
        if (projected.length === 0) return mapped
        // A backfill preserves legacy message ids, so drop any legacy message
        // that is already projected to stay idempotent. Legacy history that was
        // never backfilled must still be visible after a V2 turn appends rows.
        const projectedIDs = new Set(projected.map((message) => message.id))
        return [...mapped.filter((message) => !projectedIDs.has(message.id)), ...projected]
      }),
      timeline: Effect.fn("SessionStore.timeline")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) =>
          decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
            Effect.mapError(() => new MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make(row.id) })),
          ),
        )
      }),
      historyState,
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (row)
          return {
            sessionID: SessionSchema.ID.make(row.session_id),
            message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
          }
      // An un-migrated session has no projection row; serve the legacy one. Once
      // the legacy tables are retired there is no fallback left, and a message
      // that is not projected simply does not exist.
      if (!(yield* SessionLegacyTables.present(db))) return undefined
      const legacy = yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, messageID as unknown as SessionV1.MessageID))
          .get()
          .pipe(Effect.orDie)
        if (legacy === undefined) return undefined
        const sessionID = SessionSchema.ID.make(legacy.session_id)
        const session = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const partRows = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, messageID as unknown as SessionV1.MessageID))
          .orderBy(asc(PartTable.time_created), asc(PartTable.id))
          .all()
          .pipe(Effect.orDie)
        const [message] = SessionV1Read.map(
          [
            {
              info: { ...(legacy.data as object), id: legacy.id, sessionID } as SessionV1.Info,
              parts: partRows.map(
                (part) =>
                  ({ ...(part.data as object), id: part.id, sessionID, messageID: part.message_id }) as SessionV1.Part,
              ),
            },
          ],
          { directory: session?.directory },
        )
        return message === undefined ? undefined : { sessionID, message }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
