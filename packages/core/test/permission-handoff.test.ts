import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261029053309_legacy_permission_handoff"
import { PermissionHandoff } from "../src/permission/handoff"
import { PermissionTable } from "../src/permission/sql"
import { PermissionHandoffTable } from "../src/permission/handoff.sql"
import { PermissionSaved } from "../src/permission/saved"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { tmpdir } from "./fixture/tmpdir"

const projectID = ProjectV2.ID.make("fixture-project")
const authority = "f9c5bc45-2f85-4511-9e39-e59a1cc33085"
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped, Effect.runPromise)
const seed = Effect.fn(function* (db: Database.Interface["db"]) {
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/fixture"), sandboxes: [] })
    .run()
  yield* db
    .insert(PermissionTable)
    .values(
      ["a", "b"].map((name) => ({
        id: PermissionSaved.ID.make(`legacy-${name}`),
        project_id: projectID,
        action: "read",
        resource: `${name}/**`,
      })),
    )
    .run()
})

test("the schema upgrade preserves legacy identities and makes old permission SQL fail closed", async () => {
  await Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* db.run(sql`CREATE TABLE project(id TEXT PRIMARY KEY)`)
    yield* db.run(sql`INSERT INTO project VALUES ('fixture-project')`)
    yield* db.run(
      sql`CREATE TABLE permission(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project(id),action TEXT NOT NULL,resource TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)`,
    )
    yield* db.run(
      sql`CREATE UNIQUE INDEX permission_project_action_resource_idx ON permission(project_id,action,resource)`,
    )
    yield* db.run(sql`INSERT INTO permission VALUES ('legacy-a','fixture-project','read','a/**',123,456)`)
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* db.all(sql`SELECT * FROM permission_legacy`)).toEqual([
      { id: "legacy-a", project_id: projectID, action: "read", resource: "a/**", time_created: 123, time_updated: 456 },
    ])
    for (const statement of [
      "SELECT * FROM permission",
      "DELETE FROM permission WHERE id='legacy-a'",
      "INSERT INTO permission(id) VALUES ('new')",
    ])
      expect((yield* db.run(sql.raw(statement)).pipe(Effect.exit))._tag).toBe("Failure")
    expect(
      (yield* db
        .run(sql`INSERT INTO permission_legacy VALUES ('duplicate','fixture-project','read','a/**',123,456)`)
        .pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect(
      (yield* db
        .run(sql`INSERT INTO permission_legacy VALUES ('foreign','missing','read','b/**',123,456)`)
        .pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect(yield* db.all(sql`SELECT * FROM permission_handoff`)).toEqual([])
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
    Effect.scoped,
    Effect.runPromise,
  )
})

test("prepared source, guards and native completion survive reopen and exact retries", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "handoff.db")
  const prepared = await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database.db)
      const state = yield* PermissionHandoff.prepare(database.db, { projectID, authority })
      expect(state.rules.map((item) => item.id)).toEqual(["legacy-a", "legacy-b"])
      expect(state.receipt).toBeNull()
      for (const statement of [
        "INSERT INTO permission_legacy VALUES ('new','fixture-project','read','new/**',1,1)",
        "UPDATE permission_legacy SET resource='changed' WHERE id='legacy-a'",
        "DELETE FROM permission_legacy WHERE id='legacy-a'",
        "DELETE FROM permission_handoff WHERE project_id='fixture-project'",
        "UPDATE permission_handoff SET authority='different' WHERE project_id='fixture-project'",
      ])
        expect((yield* database.db.run(sql.raw(statement)).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* PermissionHandoff.requireLegacy(database.db, projectID).pipe(Effect.exit))._tag).toBe("Failure")
      yield* PermissionHandoff.requireLegacy(database.db, ProjectV2.ID.make("other-project"))
      expect((yield* PermissionHandoff.requireLegacy(database.db).pipe(Effect.exit))._tag).toBe("Failure")
      return state
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* PermissionHandoff.read(database.db, projectID)).toEqual(prepared)
      expect(yield* PermissionHandoff.prepare(database.db, { projectID, authority })).toEqual(prepared)
      expect(
        (yield* PermissionHandoff.prepare(database.db, {
          projectID,
          authority: "a".repeat(8) + "-1111-1111-1111-111111111111",
        }).pipe(Effect.result))._tag,
      ).toBe("Failure")
      const receipt = { project: projectID, fingerprint: prepared.fingerprint, imported: 2 }
      for (const wrong of [
        { ...receipt, project: "other" },
        { ...receipt, fingerprint: "f".repeat(64) },
        { ...receipt, imported: 1 },
      ])
        expect(
          (yield* PermissionHandoff.complete(database.db, { projectID, authority, receipt: wrong }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure")
      expect(yield* PermissionHandoff.read(database.db, projectID)).toEqual(prepared)
      const completed = yield* PermissionHandoff.complete(database.db, { projectID, authority, receipt })
      expect(completed.receipt).toEqual(receipt)
      expect(yield* PermissionHandoff.complete(database.db, { projectID, authority, receipt })).toEqual(completed)
    }),
  )
  await run(
    storage,
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt?.fingerprint).toBe(prepared.fingerprint)
      expect((yield* database.db.select().from(PermissionTable).all()).map((row) => String(row.id))).toEqual([
        "legacy-a",
        "legacy-b",
      ])
    }),
  )
})

test("prepare and completion storage failures leave a resumable boundary", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database.db)
      yield* database.db.run(
        sql`CREATE TRIGGER fail_prepare BEFORE INSERT ON permission_handoff BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
      )
      expect((yield* PermissionHandoff.prepare(database.db, { projectID, authority }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
      expect(
        yield* database.db.all(
          sql`SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'permission_handoff_%'`,
        ),
      ).toEqual([])
      yield* database.db
        .update(PermissionTable)
        .set({ resource: "changed/**" })
        .where(eq(PermissionTable.id, PermissionSaved.ID.make("legacy-a")))
        .run()
      yield* database.db.run(sql`DROP TRIGGER fail_prepare`)
      const prepared = yield* PermissionHandoff.prepare(database.db, { projectID, authority })
      yield* database.db.run(
        sql`CREATE TRIGGER fail_complete BEFORE UPDATE OF receipt ON permission_handoff BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
      )
      const receipt = { project: projectID, fingerprint: prepared.fingerprint, imported: 2 }
      expect(
        (yield* PermissionHandoff.complete(database.db, { projectID, authority, receipt }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(yield* PermissionHandoff.read(database.db, projectID)).toEqual(prepared)
      yield* database.db.run(sql`DROP TRIGGER fail_complete`)
      expect((yield* PermissionHandoff.complete(database.db, { projectID, authority, receipt })).receipt).toEqual(
        receipt,
      )
    }),
  )
})

test("oversized or corrupt legacy input never becomes a handoff receipt", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database.db)
      expect(
        (yield* PermissionHandoff.prepare(database.db, { projectID, authority: "invalid" }).pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* database.db
        .insert(PermissionTable)
        .values(
          Array.from({ length: 255 }, (_, index) => ({
            id: PermissionSaved.ID.make(`extra-${index}`),
            project_id: projectID,
            action: "read",
            resource: `extra/${index}`,
          })),
        )
        .run()
      expect((yield* PermissionHandoff.prepare(database.db, { projectID, authority }).pipe(Effect.result))._tag).toBe(
        "Failure",
      )
      expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
      yield* database.db
        .delete(PermissionTable)
        .where(eq(PermissionTable.id, PermissionSaved.ID.make("extra-254")))
        .run()
      const prepared = yield* PermissionHandoff.prepare(database.db, { projectID, authority })
      expect(prepared.rules).toHaveLength(256)
      yield* database.db.run(sql`DROP TRIGGER permission_handoff_immutable`)
      yield* database.db
        .update(PermissionHandoffTable)
        .set({ fingerprint: "f".repeat(64) })
        .where(eq(PermissionHandoffTable.project_id, projectID))
        .run()
      expect((yield* PermissionHandoff.read(database.db, projectID).pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* PermissionHandoff.complete(database.db, {
          projectID,
          authority,
          receipt: { project: projectID, fingerprint: "f".repeat(64), imported: 256 },
        }).pipe(Effect.result))._tag,
      ).toBe("Failure")
    }),
  )
})

test("native serde fingerprint and UTF-8 identity ordering match the compiled controller", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/fixture"), sandboxes: [] })
        .run()
      yield* database.db
        .insert(PermissionTable)
        .values(
          ["legacy-a", "legacy-𐀀", "legacy-\ue000"].map((id, index) => ({
            id: PermissionSaved.ID.make(id),
            project_id: projectID,
            action: "read",
            resource: ["public/**", "公开/**", "line\nbreak/**"][index]!,
          })),
        )
        .run()
      const prepared = yield* PermissionHandoff.prepare(database.db, { projectID, authority })
      expect(prepared.rules.map((item) => item.id)).toEqual(["legacy-a", "legacy-\ue000", "legacy-𐀀"])
      // Captured from the real project controller at 0f689cc20d after migrate.
      expect(prepared.fingerprint).toBe("5f11d47eb98673bc9d2d5ef07b4e9b5885abf8ae99929536526dfab8d272b05e")
    }),
  )
})

test("empty project preparation still freezes later legacy inserts", async () => {
  await run(
    ":memory:",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/fixture"), sandboxes: [] })
        .run()
      const prepared = yield* PermissionHandoff.prepare(database.db, { projectID, authority })
      expect(prepared.rules).toEqual([])
      expect(
        (yield* database.db
          .insert(PermissionTable)
          .values({ id: PermissionSaved.ID.make("late"), project_id: projectID, action: "read", resource: "late/**" })
          .run()
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* PermissionHandoff.complete(database.db, {
          projectID,
          authority,
          receipt: { project: projectID, fingerprint: prepared.fingerprint, imported: 0 },
        })).receipt?.imported,
      ).toBe(0)
    }),
  )
})
