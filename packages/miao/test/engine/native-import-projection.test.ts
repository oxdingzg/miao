import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { PermissionImportProjection } from "@miao/core/permission/import-projection"
import { PermissionSaved } from "@miao/schema/permission-saved"
import { AbsolutePath } from "@miao/core/schema"
import { EngineClient } from "@/engine/client"
import { makeNativeImportProjection } from "@/engine/native-import-projection"
import { nativeHostSource } from "../fixture/native-host-source"

test.skipIf(!process.env.MIAO_ENGINE_BIN)(
  "import replica bootstraps, replays multiple pages and refreshes after transport restart",
  async () => {
    await using fixture = await nativeHostSource()
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const sync = makeNativeImportProjection(database)
        const owner = { storage: fixture.storage, location: { directory: AbsolutePath.make(fixture.directory) } }
        const first = yield* Effect.promise(() => sync(fixture.client, owner))
        expect(first.migration).toBeNull()
        expect(first.directory).toBe(path.toNamespacedPath(fixture.directory))
        const rules = Array.from({ length: 256 }, (_, index) => ({
          id: `legacy/${index}`,
          rule: { action: "read", resource: `public/${index}`, effect: "allow" },
        }))
        const receipt = yield* Effect.promise(() =>
          fixture.client.request("permission_saved_migrate", { project: "fixture", rules }),
        )
        for (const item of rules)
          yield* Effect.promise(() => fixture.client.request("permission_saved_remove", { id: item.id }))
        const values = yield* Effect.promise(() =>
          Promise.all(Array.from({ length: 4 }, () => sync(fixture.client, owner))),
        )
        expect(values).toHaveLength(4)
        for (const value of values) {
          expect(value.rules).toEqual([])
          expect(receipt).toEqual(value.migration)
          expect(value.cursor).toBeGreaterThan(256)
        }
        expect(yield* database.db.get(sql`SELECT count(*) AS count FROM permission_legacy`)).toEqual({ count: 0 })
        const persisted = yield* PermissionImportProjection.read(database.db, owner)
        expect(persisted).toEqual(values[0])
        yield* Effect.promise(() => fixture.client.close())
        yield* Effect.promise(async () => {
          const reopened = EngineClient.start({
            binary: process.env.MIAO_ENGINE_BIN!,
            db: fixture.storage,
            workspace: fixture.directory,
            model: "fixture",
            provider: "openai-chat",
            endpoint: "http://127.0.0.1:9",
            env: { OPENAI_API_KEY: "fixture-only" },
          })
          try {
            expect(persisted).toEqual(await sync(reopened, owner))
            await reopened.request("permission_saved_migrate", { project: "fixture", rules })
            expect((await sync(reopened, owner)).rules).toEqual([])
          } finally {
            await reopened.close()
          }
        })
        expect(
          yield* Effect.promise(() =>
            sync(fixture.client, owner).then(
              () => "stale",
              () => "failed",
            ),
          ),
        ).toBe("failed")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  },
  30_000,
)

test.skipIf(!process.env.MIAO_ENGINE_BIN)(
  "new engine bootstrap clears stale persisted imported identities",
  async () => {
    await using fixture = await nativeHostSource()
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const sync = makeNativeImportProjection(database)
        const owner = { storage: fixture.storage, location: { directory: AbsolutePath.make(fixture.directory) } }
        yield* PermissionImportProjection.replace(database.db, owner, {
          directory: fixture.directory,
          cursor: 400,
          migration: { project: "old", fingerprint: "a".repeat(64), imported: 0 },
          rules: [],
        })
        expect(yield* Effect.promise(() => sync(fixture.client, owner))).toEqual({
          directory: path.toNamespacedPath(fixture.directory),
          cursor: 0,
          migration: null,
          rules: [],
        })
        const rule = { id: "arbitrary legacy id", rule: { action: "read", resource: "public", effect: "allow" } }
        yield* Effect.promise(() =>
          fixture.client.request("permission_saved_migrate", { project: "fixture", rules: [rule] }),
        )
        expect((yield* Effect.promise(() => sync(fixture.client, owner))).rules).toEqual([
          { id: PermissionSaved.ID.make(rule.id), action: "read", resource: "public" },
        ])
        // A receipt/cursor conflict must recover from native authority rather than retain stale rows.
        yield* PermissionImportProjection.replace(database.db, owner, {
          directory: path.toNamespacedPath(fixture.directory),
          cursor: 0,
          migration: { project: "old", fingerprint: "a".repeat(64), imported: 0 },
          rules: [],
        })
        const recovered = yield* Effect.promise(() => sync(fixture.client, owner))
        expect(recovered.rules).toHaveLength(1)
        expect(recovered.migration?.project).toBe("fixture")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  },
  20_000,
)
