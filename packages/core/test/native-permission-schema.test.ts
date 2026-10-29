import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { Location } from "@miao/core/location"
import { PermissionProjection } from "@miao/core/permission/projection"
import { PermissionSaved } from "@miao/core/permission/saved"
import { PermissionTable } from "@miao/core/permission/sql"
import { ProjectV2 } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { tmpdir } from "./fixture/tmpdir"

const migration = "20261029011500_native_permission_projection"
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped))
const owner = (directory: string) => ({
  storage: path.join(directory, "native.db"),
  location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
})
const snapshot = (directory: string) => ({
  directory,
  cursor: 1,
  rules: [{ id: PermissionSaved.ID.make("psv_native_prule_fixture"), action: "read", resource: "public/**" }],
})

test("fresh generated schema supports native permission replicas and reopening retains them", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "core.db")
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* PermissionProjection.replace(database.db, owner(tmp.path), snapshot(tmp.path))
      expect(yield* PermissionProjection.read(database.db, owner(tmp.path))).toEqual(snapshot(tmp.path))
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* PermissionProjection.read(database.db, owner(tmp.path))).toEqual(snapshot(tmp.path))
      expect(yield* database.db.all(sql`SELECT id FROM migration WHERE id=${migration}`)).toEqual([{ id: migration }])
    }),
  )
})

test("an existing database missing the replica migration upgrades without changing saved rules", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "core.db")
  const projectID = ProjectV2.ID.make("fixture-project")
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
        .run()
      yield* database.db
        .insert(PermissionTable)
        .values({
          id: PermissionSaved.ID.make("psv_legacy_preserved"),
          project_id: projectID,
          action: "read",
          resource: "legacy/**",
        })
        .run()
      // This is the observed broken shape: the generated fresh schema and its
      // journal omitted both replica tables and the existing historical ID.
      yield* database.db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run(sql`DROP TABLE permission_native_projection`)
          yield* tx.run(sql`DROP TABLE permission_native_cursor`)
          yield* tx.run(sql`DELETE FROM migration WHERE id=${migration}`)
        }),
      )
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* database.db.all(sql`SELECT id,action,resource FROM permission_legacy`)).toEqual([
        { id: "psv_legacy_preserved", action: "read", resource: "legacy/**" },
      ])
      yield* PermissionProjection.replace(database.db, owner(tmp.path), snapshot(tmp.path))
      expect(yield* PermissionProjection.read(database.db, owner(tmp.path))).toEqual(snapshot(tmp.path))
      expect(yield* database.db.all(sql`SELECT id FROM migration WHERE id=${migration}`)).toEqual([{ id: migration }])
    }),
  )
})
