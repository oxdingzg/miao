import { projectedPermissionTable } from "../fixture/native-permission-storage"
import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { ClientEvents } from "@miao/server/client-events"
import { Effect } from "effect"
import { makeEngineOwners } from "@/engine/owners"
import { ProductPermission } from "@/engine/product-permission"
import { location } from "../../../core/test/fixture/location"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, PermissionSaved.node, ClientEvents.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)
const binary = process.env.MIAO_ENGINE_BIN

async function storedRules(filename: string) {
  const { Database } = await import("bun:sqlite")
  const database = new Database(filename, { readonly: true })
  try {
    return database
      .query<{ rule: string }, []>(`SELECT rule FROM ${projectedPermissionTable(database)} ORDER BY digest`)
      .all()
      .map((row) => JSON.parse(row.rule) as { action: string; resource: string; effect: string })
  } finally {
    database.close()
  }
}

if (!binary)
  test.skip("saved-rule removal refreshes an existing native owner including an empty final snapshot", () => {})
if (binary)
  it.live(
    "saved-rule removal refreshes an existing native owner including an empty final snapshot",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const workspace = path.join(tmp.path, "workspace")
        yield* Effect.promise(() => mkdir(workspace))
        const ref = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
        const opened = Location.Service.of(location(ref))
        const database = yield* Database.Service
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const saved = yield* PermissionSaved.Service
        yield* saved.add({ projectID: Project.ID.global, action: "read_file", resources: ["a", "b"] })
        const initial = yield* saved.list({ projectID: Project.ID.global })
        expect(initial).toHaveLength(2)
        const owners = yield* makeEngineOwners(
          {
            binary,
            model: "fixture",
            provider: "openai-chat",
            endpoint: "http://127.0.0.1:9",
            env: { OPENAI_API_KEY: "offline-fixture-only" },
          },
          (ref) =>
            ProductPermission.prepare(ref).pipe(
              Effect.provideService(Location.Service, opened),
              Effect.map((permission) => ({
                options: permission.options,
                refresh: Effect.void,
                refreshPermissions: permission.refresh,
              })),
            ),
        )
        const input = {
          storage: path.join(tmp.path, "engine.db"),
          engineID: "saved-rules",
          location: ref,
          refreshContext: true,
        }
        const first = yield* owners.get(input)
        expect(yield* Effect.promise(() => storedRules(input.storage))).toHaveLength(2)
        yield* saved.remove(initial[0].id)
        expect(yield* owners.get(input)).toBe(first)
        expect(yield* Effect.promise(() => storedRules(input.storage))).toEqual([
          { action: "read_file", resource: initial[1].resource, effect: "allow" },
        ])
        yield* saved.remove(initial[1].id)
        expect(yield* owners.get(input)).toBe(first)
        expect(yield* Effect.promise(() => storedRules(input.storage))).toEqual([])
        const empty = yield* ProductPermission.prepare(ref).pipe(Effect.provideService(Location.Service, opened))
        expect(empty.options.savedRules).toBe("[]")
        const other = yield* ProductPermission.prepare(
          Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "other")) }),
        ).pipe(Effect.provideService(Location.Service, opened))
        expect(other.options.savedRules).toBeUndefined()
        yield* other.refresh(first.client)
      }),
    20_000,
  )
