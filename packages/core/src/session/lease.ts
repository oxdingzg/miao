export * as SessionLease from "./lease"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import type { SessionSchema } from "./schema"

type Db = Database.Interface["db"]

export type Holder = {
  readonly sessionID: SessionSchema.ID
  readonly epoch: number
  readonly holder: string
  readonly build: string
}

/**
 * Takes the lease when it is free or when its previous deadline passed. Every
 * acquisition bumps `epoch`, so a peer that still holds a stale epoch can no
 * longer renew or release it (compare-and-swap on the current row). Returns
 * undefined while a live holder keeps it.
 */
export const acquire = Effect.fn("SessionLease.acquire")(function* (
  db: Db,
  input: { sessionID: SessionSchema.ID; holder: string; build: string; now: number; ttl: number },
) {
  const row = yield* db.get<{ epoch: number }>(sql`
    INSERT INTO session_lease (session_id, epoch, holder, build, expires_at)
    VALUES (${input.sessionID}, 1, ${input.holder}, ${input.build}, ${input.now + input.ttl})
    ON CONFLICT(session_id) DO UPDATE SET
      epoch = session_lease.epoch + 1,
      holder = excluded.holder,
      build = excluded.build,
      expires_at = excluded.expires_at
    WHERE session_lease.expires_at <= ${input.now}
    RETURNING epoch
  `)
  if (!row) return undefined
  return { sessionID: input.sessionID, epoch: row.epoch, holder: input.holder, build: input.build } satisfies Holder
})

/** Extends a lease this holder still owns. False means it was fenced. */
export const renew = Effect.fn("SessionLease.renew")(function* (
  db: Db,
  input: { sessionID: SessionSchema.ID; holder: string; epoch: number; now: number; ttl: number },
) {
  const row = yield* db.get<{ epoch: number }>(sql`
    UPDATE session_lease SET expires_at = ${input.now + input.ttl}
    WHERE session_id = ${input.sessionID} AND holder = ${input.holder} AND epoch = ${input.epoch}
    RETURNING epoch
  `)
  return row !== undefined
})

/** Drops the lease only while this holder still owns the current epoch. */
export const release = Effect.fn("SessionLease.release")(function* (
  db: Db,
  input: { sessionID: SessionSchema.ID; holder: string; epoch: number },
) {
  const row = yield* db.get<{ epoch: number }>(sql`
    DELETE FROM session_lease
    WHERE session_id = ${input.sessionID} AND holder = ${input.holder} AND epoch = ${input.epoch}
    RETURNING epoch
  `)
  return row !== undefined
})

/**
 * Cooperative fence check a holder must pass before a durable write, a
 * promotion, or a provider boundary. An expired lease counts as lost even when
 * no peer has claimed it yet, so a blocked worker stops before its next effect.
 */
export const holds = Effect.fn("SessionLease.holds")(function* (
  db: Db,
  input: { sessionID: SessionSchema.ID; holder: string; epoch: number; now: number },
) {
  const row = yield* db.get<{ epoch: number }>(sql`
    SELECT epoch FROM session_lease
    WHERE session_id = ${input.sessionID} AND holder = ${input.holder} AND epoch = ${input.epoch}
      AND expires_at > ${input.now}
  `)
  return row !== undefined
})

export const holder = Effect.fn("SessionLease.holder")(function* (db: Db, sessionID: SessionSchema.ID) {
  const row = yield* db.get<{ epoch: number; holder: string; build: string }>(
    sql`SELECT epoch, holder, build FROM session_lease WHERE session_id = ${sessionID}`,
  )
  if (!row) return undefined
  return { sessionID, epoch: row.epoch, holder: row.holder, build: row.build } satisfies Holder
})

/** Leases whose deadline passed; the Runtime reassigns them to a live worker. */
export const expired = Effect.fn("SessionLease.expired")(function* (db: Db, now: number) {
  const rows = yield* db.all<{ session_id: SessionSchema.ID; epoch: number; holder: string; build: string }>(sql`
    SELECT session_id, epoch, holder, build FROM session_lease WHERE expires_at <= ${now}
  `)
  return rows.map(
    (row): Holder => ({ sessionID: row.session_id, epoch: row.epoch, holder: row.holder, build: row.build }),
  )
})

export const clear = Effect.fn("SessionLease.clear")(function* (db: Db, sessionID: SessionSchema.ID) {
  yield* db.run(sql`DELETE FROM session_lease WHERE session_id = ${sessionID}`)
})
