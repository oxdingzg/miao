import { afterAll, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "@miao/core/database/sqlite.bun"
import { Sqlite, sqliteReason } from "@miao/core/database/sqlite"

const dir = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "miao-sqlite-busy-")))
const file = path.join(dir, "busy.db")
afterAll(() => fs.rm(dir, { recursive: true, force: true }))

const runWith = <A, E>(effect: Effect.Effect<A, E, SqlClient | Sqlite.Native>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer({ filename: file })), Effect.scoped))

describe("sqlite busy retry", () => {
  test("a statement the write lock blocks succeeds once the holder releases it", async () => {
    await runWith(
      Effect.gen(function* () {
        const native = (yield* Sqlite.Native) as BunDatabase
        native.exec("CREATE TABLE t (x INTEGER)")
        // The client under test waits only 5ms natively, so with a second
        // connection holding the machine-wide writer the statement-level retry
        // is what carries the write once the holder commits.
        holder("BEGIN IMMEDIATE")
        holder("INSERT INTO t VALUES (1)")
        native.exec("PRAGMA busy_timeout = 5")

        yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis")
            holder("COMMIT")
          }),
        )
        yield* SqlClient.use((client) => client.unsafe("INSERT INTO t VALUES (2)"))

        expect((native.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(2)
      }),
    )
  })

  test("classifies a busy failure as contention and says so", () => {
    const reason = sqliteReason(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), "execute")
    expect(reason._tag).toBe("LockTimeoutError")
    expect(reason.message).toContain("Database is busy")
  })
})

let lock: BunDatabase | undefined
function holder(statement: string) {
  lock ??= new BunDatabase(file)
  lock.exec(statement)
}
