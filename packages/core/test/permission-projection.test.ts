import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { PermissionProjection } from "../src/permission/projection"
import { PermissionSaved } from "../src/permission/saved"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const owner = { storage: "/native.db", location: { directory: AbsolutePath.make("/workspace") } }
const rule = (id: string) => ({
  id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${id}`),
  action: "read",
  resource: `${id}/**`,
})
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped, Effect.runPromise)

test("ordered replay survives reopen and empty snapshots clear only the replica", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "replica.db")
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* PermissionProjection.replace(database.db, owner, {
        directory: "/workspace",
        cursor: 4,
        rules: [rule("a")],
      })
      yield* PermissionProjection.apply(database.db, owner, {
        directory: "/workspace",
        after: 4,
        cursor: 9,
        changes: [
          { seq: 5, type: "upsert", rule: rule("b") },
          { seq: 7, type: "remove", id: rule("a").id },
          { seq: 9, type: "upsert", rule: { ...rule("b"), resource: "updated/**" } },
        ],
      })
      expect(yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM permission`)).toEqual({
        count: 0,
      })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* PermissionProjection.read(database.db, owner)).toEqual({
        directory: "/workspace",
        cursor: 9,
        rules: [{ ...rule("b"), resource: "updated/**" }],
      })
      yield* PermissionProjection.replace(database.db, owner, { directory: "/workspace", cursor: 0, rules: [] })
      expect(yield* PermissionProjection.read(database.db, owner)).toEqual({
        directory: "/workspace",
        cursor: 0,
        rules: [],
      })
    }),
  )
})

test("storage and Location identities isolate replicas", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const peers = [
        owner,
        { ...owner, storage: "/other.db" },
        { ...owner, location: { directory: AbsolutePath.make("/other") } },
      ]
      for (const peer of peers) {
        expect(yield* PermissionProjection.read(database.db, peer)).toBeUndefined()
        yield* PermissionProjection.replace(database.db, peer, {
          directory: peer.location.directory,
          cursor: 1,
          rules: [rule("same")],
        })
      }
      yield* PermissionProjection.replace(database.db, owner, { directory: "/workspace", cursor: 2, rules: [] })
      expect((yield* PermissionProjection.read(database.db, peers[1]!))?.rules).toEqual([rule("same")])
      expect((yield* PermissionProjection.read(database.db, peers[2]!))?.rules).toEqual([rule("same")])
    }),
  )
})

test("invalid pages and transaction failures preserve both rows and cursor", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const before = { directory: "/workspace", cursor: 4, rules: [rule("a")] }
      yield* PermissionProjection.replace(database.db, owner, before)
      const pages = [
        {
          directory: "/workspace",
          after: 3,
          cursor: 5,
          changes: [{ seq: 5, type: "remove" as const, id: rule("a").id }],
        },
        { directory: "/other", after: 4, cursor: 5, changes: [{ seq: 5, type: "remove" as const, id: rule("a").id }] },
        {
          directory: "/workspace",
          after: 4,
          cursor: 5,
          changes: [{ seq: 6, type: "remove" as const, id: rule("a").id }],
        },
        {
          directory: "/workspace",
          after: 4,
          cursor: 260,
          changes: Array.from({ length: 256 }, (_, i) => ({
            seq: i + 5,
            type: "upsert" as const,
            rule: rule(String(i)),
          })),
        },
      ]
      for (const page of pages) {
        expect((yield* PermissionProjection.apply(database.db, owner, page).pipe(Effect.result))._tag).toBe("Failure")
        expect(yield* PermissionProjection.read(database.db, owner)).toEqual(before)
      }
      yield* database.db.run(
        sql`CREATE TRIGGER reject_replica BEFORE INSERT ON permission_native_projection WHEN NEW.action = 'blocked' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
      )
      const exit = yield* PermissionProjection.apply(database.db, owner, {
        directory: "/workspace",
        after: 4,
        cursor: 6,
        changes: [
          { seq: 5, type: "remove", id: rule("a").id },
          { seq: 6, type: "upsert", rule: { ...rule("b"), action: "blocked" } },
        ],
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* PermissionProjection.read(database.db, owner)).toEqual(before)
    }),
  )
})
