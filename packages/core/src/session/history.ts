import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"
import { DiagnosticMetrics } from "../diagnostic-metrics"

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
  readonly revision: number
  readonly baselineSeq: number | undefined
  readonly compactionSeq: number | undefined
  readonly maxSeq: number
  readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Message }>
}

// Streaming updates existing assistant rows without changing their message sequence.
// The durable event revision prevents cached partial messages from hiding their final text and finish state.
const caches = new WeakMap<object, Map<string, CachedEntries>>()
const maps = new Set<WeakRef<Map<string, CachedEntries>>>()
const reads = { hits: 0, reloads: 0, decodedRows: 0 }
DiagnosticMetrics.register("core.history", () => {
  const current = [...maps].flatMap((reference) => {
    const map = reference.deref()
    if (map) return [map]
    maps.delete(reference)
    return []
  })
  return {
    ...reads,
    databases: current.length,
    sessions: current.reduce((count, map) => count + map.size, 0),
    entries: current.reduce(
      (count, map) => count + [...map.values()].reduce((sum, cache) => sum + cache.entries.length, 0),
      0,
    ),
  }
})

function cacheFor(db: object) {
  let map = caches.get(db)
  if (!map) {
    map = new Map()
    caches.set(db, map)
    maps.add(new WeakRef(map))
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

const decodeRows = (rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>) => {
  reads.decodedRows += rows.length
  return Effect.forEach(rows, (row) => decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))))
}

const loadEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
) {
  const map = cacheFor(db)
  const compactionSeq = compaction?.seq
  const cached = map.get(sessionID)
  const revision = yield* EventV2.latestSequence(db, sessionID)
  if (
    cached &&
    cached.revision === revision &&
    cached.baselineSeq === baselineSeq &&
    cached.compactionSeq === compactionSeq
  ) {
    reads.hits += 1
    const rows = yield* messageRows(db, sessionID, compaction, baselineSeq, cached.maxSeq)
    if (rows.length === 0) return cached.entries
    const entries = [...cached.entries, ...(yield* decodeRows(rows))]
    map.set(sessionID, {
      revision,
      baselineSeq,
      compactionSeq,
      maxSeq: rows.at(-1)?.seq ?? cached.maxSeq,
      entries,
    })
    return entries
  }
  reads.reloads += 1
  const rows = yield* messageRows(db, sessionID, compaction, baselineSeq)
  const entries = yield* decodeRows(rows)
  map.set(sessionID, {
    revision,
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

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return yield* loadEntries(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
})

export * as SessionHistory from "./history"
