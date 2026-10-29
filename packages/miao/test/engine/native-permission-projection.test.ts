import { Database } from "@miao/core/database/database"
import { PermissionProjection } from "@miao/core/permission/projection"
import { makeNativePermissionProjection } from "@/engine/native-permission-projection"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { ConflictError } from "@miao/protocol/errors"
import { PermissionSaved } from "@miao/schema/permission-saved"
import { ClientEvents } from "@miao/server/client-events"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const binary = process.env.MIAO_ENGINE_BIN
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ClientEvents.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

if (!binary)
  test.skip("durable native permission projection follows external mutations, concurrent queries and transport restart", () => {})
if (binary)
  it.live(
    "durable native permission projection follows external mutations, concurrent queries and transport restart",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const root = path.join(tmp.path, "engines")
        const first = Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "first")) })
        const other = Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "other")) })
        yield* Effect.promise(() =>
          Promise.all(
            [root, first.directory, other.directory].map((directory) => mkdir(directory, { recursive: true })),
          ),
        )
        const owners = yield* makeEngineOwners({
          binary,
          model: "fixture",
          provider: "openai-chat",
          endpoint: "http://127.0.0.1:9",
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        const input = { location: first, projectID: Project.ID.global }
        const connection = yield* owners.get({
          location: first,
          storage: SessionEnginePlacement.storageFor(root, first),
          engineID: SessionEnginePlacement.storageFor(root, first),
        })
        const pattern = yield* Effect.promise(() =>
          connection.client.request("permission_pattern_put", {
            rule: { action: "read", resource: "public", effect: "allow" },
          }),
        )
        const workspace = Schema.decodeUnknownSync(Schema.Struct({ workspace: Schema.String }))(pattern).workspace
        yield* Effect.promise(() =>
          connection.client.request("permission_saved_project", {
            workspace,
            rules: [{ action: "read", resource: "legacy", effect: "allow" }],
          }),
        )
        const database = yield* Database.Service
        const native = fromOwners(
          owners,
          { nativePatterns: true, permissionProjection: makeNativePermissionProjection(database) },
          root,
        )
        if (!native.savedPermissions || !native.removeSavedPermission)
          throw new Error("saved permission methods required")
        const saved = yield* native.savedPermissions(input)
        expect(saved).toHaveLength(1)
        expect(Schema.decodeUnknownSync(PermissionSaved.Info)(saved[0])).toEqual({
          id: saved[0].id,
          projectID: Project.ID.global,
          action: "read",
          resource: "public",
          origin: "native",
          scope: { type: "directory", directory: workspace },
        })
        expect(saved[0].id.startsWith(PermissionSaved.NativePrefix)).toBe(true)
        expect(yield* native.savedPermissions(input)).toEqual(saved)
        const replicaOwner = { storage: SessionEnginePlacement.storageFor(root, first), location: first }
        expect((yield* PermissionProjection.read(database.db, replicaOwner))?.rules).toHaveLength(1)
        yield* Effect.promise(() =>
          connection.client.request("permission_pattern_put", {
            rule: { action: "read", resource: "external/**", effect: "allow" },
          }),
        )
        const simultaneous = yield* Effect.all([native.savedPermissions(input), native.savedPermissions(input)], {
          concurrency: "unbounded",
        })
        expect(simultaneous[0]).toEqual(simultaneous[1])
        expect(simultaneous[0]).toHaveLength(2)
        const external = simultaneous[0].find((item) => item.resource === "external/**")!
        yield* native.removeSavedPermission({ location: first, id: external.id })
        expect(yield* native.savedPermissions(input)).toEqual(saved)
        // More than one durable page, with removals leaving no extra standing rules.
        yield* Effect.promise(async () => {
          for (let index = 0; index < 129; index++) {
            const pattern = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
              await connection.client.request("permission_pattern_put", {
                rule: { action: "read", resource: `paged-${index}`, effect: "allow" },
              }),
            )
            await connection.client.request("permission_pattern_remove", { rule_id: pattern.id })
          }
        })
        expect(yield* native.savedPermissions(input)).toEqual(saved)
        expect((yield* PermissionProjection.read(database.db, replicaOwner))?.cursor).toBeGreaterThan(256)
        yield* Effect.promise(() => connection.client.close())
        expect(yield* native.savedPermissions(input)).toEqual(saved)
        const second = yield* owners.get({
          location: other,
          storage: SessionEnginePlacement.storageFor(root, other),
          engineID: SessionEnginePlacement.storageFor(root, other),
        })
        yield* Effect.promise(() =>
          second.client.request("permission_pattern_put", {
            rule: { action: "read", resource: "public", effect: "allow" },
          }),
        )
        const foreign = yield* native.savedPermissions({ location: other, projectID: Project.ID.global })
        expect(foreign).toHaveLength(1)
        expect(foreign[0].id).not.toBe(saved[0].id)
        yield* native.removeSavedPermission({ location: first, id: foreign[0].id })
        expect(yield* native.savedPermissions(input)).toEqual(saved)
        expect(yield* native.savedPermissions({ location: other, projectID: Project.ID.global })).toEqual(foreign)
        expect(yield* Effect.promise(() => legacyCount(SessionEnginePlacement.storageFor(root, first)))).toBe(1)
        yield* native.removeSavedPermission({ location: first, id: saved[0].id })
        yield* native.removeSavedPermission({ location: first, id: saved[0].id })
        expect(yield* native.savedPermissions(input)).toEqual([])
        yield* PermissionProjection.replace(database.db, replicaOwner, {
          directory: workspace,
          cursor: 999,
          rules: saved,
        })
        const active = yield* owners.get({ ...replicaOwner, engineID: replicaOwner.storage })
        yield* Effect.promise(() => active.client.close())
        expect(yield* native.savedPermissions(input)).toEqual([])
        expect((yield* PermissionProjection.read(database.db, replicaOwner))?.rules).toEqual([])
        expect(yield* Effect.promise(() => legacyCount(SessionEnginePlacement.storageFor(root, first)))).toBe(1)
        expect(yield* native.savedPermissions({ location: other, projectID: Project.ID.global })).toEqual(foreign)
        const unsupported = fromOwners(owners, {}, root)
        const noRoot = fromOwners(owners, { nativePatterns: true })
        for (const engine of [unsupported, noRoot]) {
          if (!engine.savedPermissions || !engine.removeSavedPermission) throw new Error("saved methods required")
          expect(yield* engine.savedPermissions(input)).toEqual([])
          const exit = yield* Effect.exit(engine.removeSavedPermission({ location: other, id: foreign[0].id }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ConflictError)
        }
        expect(yield* native.savedPermissions({ location: other, projectID: Project.ID.global })).toEqual(foreign)
      }),
    20_000,
  )

async function legacyCount(filename: string) {
  const { Database } = await import("bun:sqlite")
  const database = new Database(filename, { readonly: true })
  try {
    return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM engine_permission_rule").get()?.count
  } finally {
    database.close()
  }
}
