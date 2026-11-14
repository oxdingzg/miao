import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import remoteOperationsMigration from "../src/database/migration/20261004190240_remote_control_operations"
import { RemoteOperations } from "../src/runtime/operations"
import { tmpdir } from "./fixture/tmpdir"

test("durable remote receipts reconcile exact retries and isolate device subjects", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.transaction((tx) => remoteOperationsMigration.up(tx))
      const input = {
        subject: "device-a",
        id: "operation-1",
        method: "session.prompt",
        session_id: "ses_a",
        project_id: null,
        digest: "payload-a",
      }
      expect((yield* RemoteOperations.prepare(db, input)).type).toBe("created")
      expect((yield* RemoteOperations.prepare(db, input)).type).toBe("existing")
      expect((yield* RemoteOperations.prepare(db, { ...input, digest: "different" })).type).toBe("conflict")
      expect((yield* RemoteOperations.prepare(db, { ...input, session_id: "ses_b" })).type).toBe("conflict")
      expect((yield* RemoteOperations.prepare(db, { ...input, method: "session.interrupt" })).type).toBe("conflict")
      expect((yield* RemoteOperations.prepare(db, { ...input, subject: "device-b" })).type).toBe("created")
      yield* RemoteOperations.settle(db, input.subject, input.id, "accepted", { messageID: "msg_a" })
      expect(
        yield* RemoteOperations.settle(db, input.subject, input.id, "rejected", { reason: "late" }),
      ).toBeUndefined()
      const receipt = yield* RemoteOperations.get(db, input.subject, input.id)
      expect(receipt?.status).toBe("accepted")
      expect(receipt?.result).toEqual({ messageID: "msg_a" })
      expect((yield* RemoteOperations.get(db, "device-b", input.id))?.status).toBe("prepared")
      expect(yield* RemoteOperations.get(db, "unapproved-device", input.id)).toBeUndefined()
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  )
})

test("prepared and settled receipts survive closing and reopening storage", async () => {
  await using dir = await tmpdir()
  const input = {
    subject: "device-a",
    id: "operation-1",
    method: "session.interrupt",
    session_id: "ses_a",
    project_id: null,
    digest: "execution-a",
  }
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(SqliteClient.layer({ filename: `${dir.path}/receipts.db` })), Effect.scoped),
    )
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.transaction((tx) => remoteOperationsMigration.up(tx))
      expect((yield* RemoteOperations.prepare(db, input)).type).toBe("created")
    }),
  )
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const receipt = yield* RemoteOperations.prepare(db, input)
      expect(receipt.type).toBe("existing")
      if (receipt.type !== "existing") throw new Error("Missing durable receipt")
      expect(receipt.record.status).toBe("prepared")
      yield* RemoteOperations.settle(db, input.subject, input.id, "outcome_unknown", { retryAllowed: false })
    }),
  )
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      expect((yield* RemoteOperations.get(db, input.subject, input.id))?.status).toBe("outcome_unknown")
      expect(yield* RemoteOperations.settle(db, input.subject, input.id, "completed", {})).toBeUndefined()
    }),
  )
})
