import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

type CachedEntries = {
  readonly baselineSeq: number | undefined
  readonly compactionSeq: number | undefined
  readonly maxSeq: number
  readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Message }>
}

// A Session's projected history only grows between compaction (which changes
// the baseline/compaction cutoff) and revert (which deletes rows). Caching the
// decoded rows lets each provider turn decode only newly appended messages
// instead of the whole transcript. The projector is the sole writer of
// `session_message`, so it also owns invalidation.
const caches = new WeakMap<object, Map<string, CachedEntries>>()

function cacheFor(db: object) {
  let map = caches.get(db)
  if (!map) {
    map = new Map()
    caches.set(db, map)
  }
  return map
}

export function invalidate(db: object) {
  caches.get(db)?.clear()
}

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
  afterSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        afterSeq === undefined ? undefined : gt(SessionMessageTable.seq, afterSeq),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const decodeRows = (rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>) =>
  Effect.forEach(rows, (row) => decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))))

const loadEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
) {
  const map = cacheFor(db)
  const compactionSeq = compaction?.seq
  const cached = map.get(sessionID)
  if (cached && cached.baselineSeq === baselineSeq && cached.compactionSeq === compactionSeq) {
    const rows = yield* messageRows(db, sessionID, compaction, baselineSeq, cached.maxSeq)
    if (rows.length === 0) return cached.entries
    const entries = [...cached.entries, ...(yield* decodeRows(rows))]
    map.set(sessionID, {
      baselineSeq,
      compactionSeq,
      maxSeq: rows.at(-1)?.seq ?? cached.maxSeq,
      entries,
    })
    return entries
  }
  const rows = yield* messageRows(db, sessionID, compaction, baselineSeq)
  const entries = yield* decodeRows(rows)
  map.set(sessionID, {
    baselineSeq,
    compactionSeq,
    maxSeq: rows.at(-1)?.seq ?? -1,
    entries,
  })
  return entries
})

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  return (yield* loadEntries(db, sessionID, compaction, epoch?.baselineSeq)).map((entry) => entry.message)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* loadEntries(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)).map(
    (entry) => entry.message,
  )
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return yield* loadEntries(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
})

export * as SessionHistory from "./history"
