export * as SessionBackfill from "./backfill"

import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionLegacyTables } from "./legacy-tables"
import { SessionV1Read } from "./v1-read"

const encode = Schema.encodeSync(SessionMessage.Message)
const decode = Schema.decodeUnknownSync(SessionMessage.Message)

export interface Result {
  /** Sessions that had no projection and were converted from legacy-only history. */
  readonly migrated: number
  /** Sessions whose stranded legacy messages were appended to an existing projection. */
  readonly repaired: number
}

export interface VerifyResult {
  /** Sessions a migration would touch. */
  readonly sessions: number
  /** Legacy messages a migration would project. */
  readonly messages: number
  /** Rows that do not survive a projection round trip. */
  readonly failures: ReadonlyArray<{ readonly sessionID: string; readonly messageID: string; readonly error: string }>
}

export interface Options {
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean
}

/**
 * Sessions holding legacy messages the projection does not cover: those with no
 * projection at all, and those whose projection is missing some legacy message.
 */
const targets = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    // `miao db compact` retires the legacy tables once everything is projected,
    // so a later backfill has nothing to read and must not query a table that is
    // gone — becoming a no-op is the contract.
    if (!(yield* SessionLegacyTables.present(db))) return { legacy: [], mixed: [] }

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

    return { legacy, mixed }
  })

/** Reads a session's legacy transcript and projects it into V2 messages. */
const read = (db: Pick<Database.Interface["db"], "select">, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
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
    const partRows = yield* db
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

    return SessionV1Read.map(
      messageRows.map((message) => ({
        info: { ...(message.data as object), id: message.id, sessionID } as SessionV1.Info,
        parts: byMessage.get(message.id) ?? [],
      })),
      { directory: session?.directory },
    )
  })

/**
 * One-time, idempotent backfill: converts legacy V1 `message` / `part` rows into
 * projected V2 `session_message` rows. Each session is migrated in its own
 * transaction. Sessions with no projection are `migrated`; sessions that already
 * have a projection but still hold legacy messages without one are `repaired`.
 */
export const backfill = (db: Database.Interface["db"], options: Options = {}) =>
  Effect.gen(function* () {
    const { legacy, mixed } = yield* targets(db)

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

/**
 * Checks every projection a migration would write, without writing. Encoding
 * that does not throw is not enough: the writer splits an encoded message across
 * columns, the reader reassembles it, and the model then sees that reading — so
 * the projection has to survive the whole round trip unchanged. A mapping that
 * only fails here would otherwise die mid-migration, after some sessions were
 * already committed.
 */
export const verify = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const { legacy, mixed } = yield* targets(db)
    const failures: { sessionID: string; messageID: string; error: string }[] = []
    let messages = 0

    for (const row of [...legacy, ...mixed]) {
      const sessionID = SessionSchema.ID.make(row.id)
      const mapped = yield* read(db, sessionID)
      for (const message of mapped) {
        messages += 1
        try {
          const encoded = encode(message)
          const { id, type, ...data } = encoded
          const restored = encode(decode({ ...data, id, type }))
          if (JSON.stringify(restored) !== JSON.stringify(encoded))
            failures.push({ sessionID, messageID: message.id, error: "projection does not round trip" })
        } catch (error) {
          failures.push({ sessionID, messageID: message.id, error: String(error) })
        }
      }
    }

    return { sessions: legacy.length + mixed.length, messages, failures }
  })

const migrateSession = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* write(tx, sessionID, yield* read(tx, sessionID))
      }),
    )
    .pipe(Effect.orDie)

/**
 * Writes event-less projected messages into a session, skipping ids it already
 * holds. Used by the backfill and by `miao import`, so it must run inside the
 * caller's transaction to stay all-or-nothing.
 */
export const write = (
  tx: Pick<Database.Interface["db"], "select" | "insert">,
  sessionID: SessionSchema.ID,
  messages: ReadonlyArray<SessionMessage.Message>,
) =>
  Effect.gen(function* () {
    const existing = yield* tx
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const projected = new Set(existing.map((row) => row.id))
    const stranded = messages.filter((message) => !projected.has(message.id))
    if (stranded.length === 0) return 0

    // `session_message.seq` is the EventV2 aggregate sequence, and future
    // events continue from the session's current maximum. Messages without an
    // event go strictly below every sequence already used (always negative) to
    // avoid colliding with the next event and to keep them identifiable as
    // event-less projection.
    let seq = existing.reduce((min, row) => Math.min(min, row.seq), 0) - stranded.length
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
    return stranded.length
  })
