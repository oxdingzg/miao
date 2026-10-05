import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, ne, or, sql } from "drizzle-orm"
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

type Fingerprint = { readonly id: string; readonly time_updated: number; readonly bytes: number }

type CachedEntries = {
  readonly revision: number
  readonly baselineSeq: number | undefined
  readonly compactionSeq: number | undefined
  readonly maxSeq: number
  readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Message }>
  readonly fingerprints: ReadonlyMap<number, Fingerprint>
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

// Bound so a long-lived process that visits many sessions does not retain every
// decoded transcript (including its base64 media) for its whole lifetime.
const MAX_CACHED_SESSIONS = 64

// Insertion order doubles as recency: a re-set moves the session to the end.
function remember(map: Map<string, CachedEntries>, sessionID: SessionSchema.ID, value: CachedEntries) {
  map.delete(sessionID)
  map.set(sessionID, value)
  if (map.size <= MAX_CACHED_SESSIONS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

const messageFilter = (
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
  afterSeq?: number,
) =>
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
  )

const messageColumns = getTableColumns(SessionMessageTable)

// A row can carry megabytes of legacy detail under `metadata.v1` (the preserved
// V1 transcript an export rebuilds), and nothing on the history read path reads
// it. Drop it in SQLite before drizzle JSON-parses the row so the decode never
// materializes the blob. `metadata` itself stays: the runner reads its
// leak-recovery marker, and `data.snapshot` is the live V2 assistant snapshot.
const withoutLegacyMetadata = sql`json_remove(${SessionMessageTable.data}, '$.metadata.v1')`.mapWith(
  SessionMessageTable.data.mapFromDriverValue,
)

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
  afterSeq?: number,
) {
  const rows = yield* db
    .select({
      ...messageColumns,
      data: withoutLegacyMetadata,
      bytes: sql<number>`length(${SessionMessageTable.data})`,
    })
    .from(SessionMessageTable)
    .where(messageFilter(sessionID, compaction, baselineSeq, afterSeq))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

// Cheap change fingerprint: the same WHERE filters as messageRows() but without
// the potentially multi-megabyte `data` column, so an incremental reload can
// find the rows that changed without parsing and decoding every row.
const messageFingerprints = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
) {
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      time_updated: SessionMessageTable.time_updated,
      bytes: sql<number>`length(${SessionMessageTable.data})`,
    })
    .from(SessionMessageTable)
    .where(messageFilter(sessionID, compaction, baselineSeq))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const messageRowsBySeq = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
  seqs: ReadonlyArray<number>,
) {
  const rows = yield* db
    .select({
      ...messageColumns,
      data: withoutLegacyMetadata,
      bytes: sql<number>`length(${SessionMessageTable.data})`,
    })
    .from(SessionMessageTable)
    .where(and(messageFilter(sessionID, compaction, baselineSeq), inArray(SessionMessageTable.seq, seqs)))
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

// Rebuild the cache after a revision bump by reusing every decoded message whose
// row fingerprint is unchanged and decoding only the rows that are new or edited
// in place. A bump that leaves every fingerprint intact (a session-level event
// that never touches `session_message`) reuses the decoded entries unchanged.
const incrementalEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq: number | undefined,
  revision: number,
  cached: CachedEntries,
) {
  const rows = yield* messageFingerprints(db, sessionID, compaction, baselineSeq)
  const cachedBySeq = new Map(cached.entries.map((entry) => [entry.seq, entry.message]))
  const changed = rows
    .filter((row) => {
      const fingerprint = cached.fingerprints.get(row.seq)
      const message = cachedBySeq.get(row.seq)
      return !(
        fingerprint?.id === row.id &&
        fingerprint.time_updated === row.time_updated &&
        fingerprint.bytes === row.bytes &&
        message
      )
    })
    .map((row) => row.seq)
  // The revision advanced but every row's identity, update time, and encoded
  // length are unchanged, so the event did not touch `session_message` (a title,
  // archive, or agent switch, for example). Reuse the decoded cache instead of
  // re-decoding the whole session. Length is part of the fingerprint so an
  // in-place edit in the same millisecond that changed the payload is detected.
  if (changed.length === 0 && rows.length === cached.entries.length) return { ...cached, revision }
  const decoded =
    changed.length === 0
      ? new Map<number, SessionMessage.Message>()
      : new Map(
          (yield* decodeRows(yield* messageRowsBySeq(db, sessionID, compaction, baselineSeq, changed))).map(
            (entry) => [entry.seq, entry.message] as const,
          ),
        )
  return {
    revision,
    baselineSeq,
    compactionSeq: compaction?.seq,
    maxSeq: rows.at(-1)?.seq ?? -1,
    entries: rows.flatMap((row) => {
      const message = decoded.get(row.seq) ?? cachedBySeq.get(row.seq)
      return message ? [{ seq: row.seq, message }] : []
    }),
    fingerprints: new Map(
      rows.map((row) => [row.seq, { id: row.id, time_updated: row.time_updated, bytes: row.bytes }]),
    ),
  } satisfies CachedEntries
})

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
    if (rows.length === 0) {
      remember(map, sessionID, cached)
      return cached.entries
    }
    const entries = [...cached.entries, ...(yield* decodeRows(rows))]
    remember(map, sessionID, {
      revision,
      baselineSeq,
      compactionSeq,
      maxSeq: rows.at(-1)?.seq ?? cached.maxSeq,
      entries,
      fingerprints: new Map([
        ...cached.fingerprints,
        ...rows.map((row) => [row.seq, { id: row.id, time_updated: row.time_updated, bytes: row.bytes }] as const),
      ]),
    })
    return entries
  }
  reads.reloads += 1
  const incremental =
    cached && cached.baselineSeq === baselineSeq && cached.compactionSeq === compactionSeq
      ? yield* incrementalEntries(db, sessionID, compaction, baselineSeq, revision, cached)
      : undefined
  if (incremental) {
    remember(map, sessionID, incremental)
    return incremental.entries
  }
  const rows = yield* messageRows(db, sessionID, compaction, baselineSeq)
  const entries = yield* decodeRows(rows)
  remember(map, sessionID, {
    revision,
    baselineSeq,
    compactionSeq,
    maxSeq: rows.at(-1)?.seq ?? -1,
    entries,
    fingerprints: new Map(
      rows.map((row) => [row.seq, { id: row.id, time_updated: row.time_updated, bytes: row.bytes }]),
    ),
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

/**
 * Every durable message for a Session, including the ones a compaction moved out
 * of the provider-facing projection. Read-only: callers use it to look back at
 * content the summary dropped, so it deliberately ignores the compaction
 * boundary that `load`/`entriesForRunner` apply.
 */
export const all = Effect.fn("SessionHistory.all")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select({
      ...messageColumns,
      data: withoutLegacyMetadata,
      bytes: sql<number>`length(${SessionMessageTable.data})`,
    })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* decodeRows(rows)
})

export * as SessionHistory from "./history"
