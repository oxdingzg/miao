import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { PermissionImportProjection } from "../src/permission/import-projection"
import { PermissionSaved } from "../src/permission/saved"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const owner = { storage: "/native.db", location: { directory: AbsolutePath.make("/workspace") } }
const migration = { project: "project", fingerprint: "a".repeat(64), imported: 2 }
const rules = ["legacy/a", "legacy/b"].map((id) => ({
  id: PermissionSaved.ID.make(id),
  action: "read",
  resource: "**",
}))
const empty = { directory: "/workspace", cursor: 0, migration: null, rules: [] }
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped, Effect.runPromise)

test("migration and revocation replay survive reopen without writing legacy authority", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "replica.db")
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* PermissionImportProjection.replace(database.db, owner, empty)
      yield* PermissionImportProjection.apply(database.db, owner, {
        directory: "/workspace",
        after: 0,
        cursor: 3,
        changes: [
          { seq: 1, type: "migrated", migration, rules },
          { seq: 3, type: "removed", id: rules[0]!.id, fingerprint: migration.fingerprint },
        ],
      })
      expect(yield* database.db.get(sql`SELECT count(*) AS count FROM permission_legacy`)).toEqual({ count: 0 })
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* PermissionImportProjection.read(database.db, owner)).toEqual({
        ...empty,
        cursor: 3,
        migration,
        rules: [rules[1]],
      })
      yield* PermissionImportProjection.replace(database.db, owner, {
        ...empty,
        migration: { ...migration, imported: 0 },
      })
      expect((yield* PermissionImportProjection.read(database.db, owner))?.rules).toEqual([])
      expect((yield* PermissionImportProjection.read(database.db, owner))?.migration?.imported).toBe(0)
    }),
  )
})

test("invalid replay, foreign receipts and SQL failures preserve rules and cursor", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const before = { ...empty, cursor: 1, migration, rules }
      yield* PermissionImportProjection.replace(database.db, owner, before)
      const remove = { seq: 2, type: "removed" as const, id: rules[0]!.id, fingerprint: migration.fingerprint }
      const page = { directory: "/workspace", after: 1, cursor: 2, changes: [remove] }
      const pages: Parameters<typeof PermissionImportProjection.apply>[2][] = [
        { ...page, after: 0 },
        { ...page, directory: "/foreign" },
        { ...page, cursor: 3 },
        { ...page, changes: [{ ...remove, fingerprint: "b".repeat(64) }] },
        { ...page, changes: [{ seq: 2, type: "migrated", migration, rules }] },
        { ...page, changes: [remove, remove] },
      ]
      for (const input of pages) {
        expect((yield* PermissionImportProjection.apply(database.db, owner, input).pipe(Effect.result))._tag).toBe(
          "Failure",
        )
        expect(yield* PermissionImportProjection.read(database.db, owner)).toEqual(before)
      }
      yield* database.db.run(
        sql`CREATE TRIGGER reject_import_replica BEFORE UPDATE ON permission_import_replica BEGIN SELECT RAISE(ABORT, 'storage failure'); END`,
      )
      expect((yield* PermissionImportProjection.apply(database.db, owner, page).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* PermissionImportProjection.read(database.db, owner)).toEqual(before)
    }),
  )
})

test("storage and location identities isolate replicas and malformed bootstraps fail", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const peer = { ...owner, storage: "/other.db" }
      yield* PermissionImportProjection.replace(database.db, owner, { ...empty, migration, rules })
      expect(yield* PermissionImportProjection.read(database.db, peer)).toBeUndefined()
      expect(
        yield* PermissionImportProjection.read(database.db, {
          ...owner,
          location: { directory: AbsolutePath.make("/other") },
        }),
      ).toBeUndefined()
      yield* PermissionImportProjection.replace(database.db, peer, empty)
      expect((yield* PermissionImportProjection.read(database.db, owner))?.rules).toEqual(rules)
      for (const input of [
        { ...empty, rules },
        { ...empty, migration, rules: [rules[0]!, rules[0]!] },
        { ...empty, migration: { ...migration, imported: 1 }, rules },
        { ...empty, cursor: -1 },
      ]) {
        expect((yield* PermissionImportProjection.replace(database.db, owner, input).pipe(Effect.result))._tag).toBe(
          "Failure",
        )
      }
      expect((yield* PermissionImportProjection.read(database.db, owner))?.rules).toEqual(rules)
    }),
  )
})
