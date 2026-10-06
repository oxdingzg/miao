export * as Sqlite from "./sqlite"

import { Context } from "effect"
import * as Effect from "effect/Effect"
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
 * retrying the single statement is side-effect free.
 */
export const SQLITE_BUSY_RETRY_DELAYS_MS = [100, 500, 2500]

/** Jittered backoff step for the n-th busy retry (0-based). */
export const sqliteBusyDelayMs = (attempt: number) =>
  Math.round(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]! * (0.8 + Math.random() * 0.4))

export const sqliteReason = (cause: unknown, operation: string): SqlErrorReason => {
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

/**
 * The failure continuation for one busy statement. Kept off the success path
 * on purpose: the drivers run statements inside `Effect.withFiber`, and every
 * extra effect node shifts the fiber's op scheduling, which is observable to
 * concurrently running drains.
 */
export const retrySqliteBusy = <A>(
  error: SqlError,
  attempt: number,
  resume: () => Effect.Effect<A, SqlError>,
): Effect.Effect<A, SqlError> => {
  if (error.reason._tag !== "LockTimeoutError" || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length)
    return Effect.fail(error)
  return Effect.sleep(`${sqliteBusyDelayMs(attempt)} millis`).pipe(Effect.andThen(resume))
}
