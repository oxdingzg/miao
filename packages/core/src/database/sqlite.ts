export * as Sqlite from "./sqlite"

import { Context } from "effect"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import { classifySqliteError, LockTimeoutError, SqlError, type SqlErrorReason } from "effect/unstable/sql/SqlError"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@miao/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@miao/core/database/SqliteDrizzle") {}

/**
 * SQLite allows one writer per database machine-wide, and the drivers' busy
 * timeout blocks synchronously inside the native call, so a burst of window
 * runtimes writing at once can still exceed it and surface as a failed drain.
 * A statement that failed with SQLITE_BUSY never executed, and transactions
 * open with BEGIN IMMEDIATE and hold the writer for their whole duration, so
 * retrying the single statement after an event-loop yield is side-effect free.
 */
const lockSchedule = Schedule.exponential(100, 5).pipe(Schedule.jittered)

export const retrySqliteBusy = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, SqlError, R> =>
  effect.pipe(
    Effect.retry({
      times: 3,
      while: (error) => error.reason._tag === "LockTimeoutError",
      schedule: lockSchedule,
    }),
  )

const sqliteReason = (cause: unknown, operation: string): SqlErrorReason => {
  const reason = classifySqliteError(cause, { message: "Failed to execute statement", operation })
  // A bare "Failed to execute statement" hides the one contention failure
  // multi-window setups actually hit; name what happened and that a retry is
  // already underway.
  return reason._tag === "LockTimeoutError"
    ? new LockTimeoutError({
        message: "Database is busy: another miao window is writing; retrying",
        operation,
        cause: reason.cause,
      })
    : reason
}

export const executeSqlite = <A>(execute: () => A, operation = "execute"): Effect.Effect<A, SqlError> =>
  Effect.try({ try: execute, catch: (cause) => new SqlError({ reason: sqliteReason(cause, operation) }) }).pipe(
    retrySqliteBusy,
  )
