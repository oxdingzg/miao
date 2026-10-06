import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { executeSqlite } from "@miao/core/database/sqlite"

class Busy extends Error {
  override readonly name = "SQLiteError"
  readonly code = "SQLITE_BUSY"
}

describe("executeSqlite", () => {
  test("retries a statement the writer lock blocked and then succeeds", async () => {
    let attempts = 0
    const started = Date.now()
    const result = await Effect.runPromise(
      executeSqlite(() => {
        attempts += 1
        if (attempts < 3) throw new Busy()
        return attempts
      }),
    )
    expect(result).toBe(3)
    // The lock schedule yields to the event loop instead of retrying inline,
    // so at least the first backoff step must have elapsed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  test("names the contention failure once the retry budget is spent", async () => {
    const exit = await Effect.runPromiseExit(
      executeSqlite(() => {
        throw new Busy()
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const error = Cause.squash(exit.cause) as Error
      expect(error.message).toContain("Database is busy")
    }
  })

  test("fails a non-busy error immediately without retrying", async () => {
    let attempts = 0
    const started = Date.now()
    const exit = await Effect.runPromiseExit(
      executeSqlite(() => {
        attempts += 1
        throw Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" })
      }),
    )
    expect(exit._tag).toBe("Failure")
    expect(attempts).toBe(1)
    expect(Date.now() - started).toBeLessThan(50)
  })
})
