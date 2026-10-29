import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { PermissionHandoff } from "@miao/core/permission/handoff"
import { PermissionTable } from "@miao/core/permission/sql"
import { PermissionSaved } from "@miao/core/permission/saved"
import { ProjectV2 } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { handoffNativeProjectPermissions } from "@/engine/native-project-permission-handoff"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const projectID = ProjectV2.ID.make("fixture-project")
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped, Effect.runPromise)
const seed = Effect.fn(function* (db: Database.Interface["db"], directory: string) {
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .run()
  yield* db
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
})
const failure = (value: Promise<unknown>) =>
  value.then(
    () => undefined,
    (error: unknown) => error,
  )
const open = (db: string, project: string = projectID) =>
  EngineClient.startPermissionStore({ binary: binary!, db, project })
const migrate = (db: Database.Interface["db"], client: Pick<EngineClient, "request">) =>
  handoffNativeProjectPermissions({ db, client, projectID, capabilities: capabilities(binary!) ?? {} })

test.skipIf(!binary)(
  "host handoff commits the real native receipt and retains revocations after both stores reopen",
  async () => {
    await using tmp = await tmpdir()
    const storage = path.join(tmp.path, "core.db")
    const native = path.join(tmp.path, "permissions.db")
    const client = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          const saved = yield* Effect.promise(() => migrate(database.db, client))
          expect(saved.rules.map((item) => item.id)).toEqual(["legacy-a", "legacy-\ue000", "legacy-𐀀"])
          expect(saved.migration?.fingerprint).toBe("5f11d47eb98673bc9d2d5ef07b4e9b5885abf8ae99929536526dfab8d272b05e")
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toEqual(saved.migration)
          expect((yield* PermissionHandoff.requireLegacy(database.db, projectID).pipe(Effect.exit))._tag).toBe(
            "Failure",
          )
        }),
      )
      expect(await client.request("remove", { id: "legacy-a" })).toEqual({ removed: true })
    } finally {
      await client.close()
    }
    const reopened = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const saved = yield* Effect.promise(() => migrate(database.db, reopened))
          expect(saved.rules.map((item) => item.id)).toEqual(["legacy-\ue000", "legacy-𐀀"])
          expect((yield* PermissionHandoff.read(database.db, projectID))?.rules).toHaveLength(3)
          expect(yield* database.db.select().from(PermissionTable).all()).toHaveLength(3)
        }),
      )
    } finally {
      await reopened.close()
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "a lost native commit response leaves the frozen source resumable without resurrecting revocations",
  async () => {
    await using tmp = await tmpdir()
    const storage = path.join(tmp.path, "core.db")
    const native = path.join(tmp.path, "permissions.db")
    const client = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          const lost = {
            request: async (method: string, params?: unknown) => {
              const response = await client.request(method, params)
              if (method === "handoff") throw new Error("injected lost native commit response")
              return response
            },
          }
          expect(yield* Effect.promise(() => failure(migrate(database.db, lost)))).toBeInstanceOf(Error)
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toBeNull()
        }),
      )
      expect(await client.request("remove", { id: "legacy-a" })).toEqual({ removed: true })
    } finally {
      await client.close()
    }
    const reopened = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const saved = yield* Effect.promise(() => migrate(database.db, reopened))
          expect(saved.rules).toHaveLength(2)
          expect(saved.rules.some((item) => item.id === "legacy-a")).toBe(false)
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toEqual(saved.migration)
        }),
      )
    } finally {
      await reopened.close()
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "a failed Core completion does not roll native state back or unfreeze the old source",
  async () => {
    await using tmp = await tmpdir()
    const client = open(path.join(tmp.path, "permissions.db"))
    try {
      await run(
        path.join(tmp.path, "core.db"),
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          yield* database.db.run(
            sql`CREATE TRIGGER fail_prepare BEFORE INSERT ON permission_handoff BEGIN SELECT RAISE(ABORT,'injected prepare failure'); END`,
          )
          expect(yield* Effect.promise(() => failure(migrate(database.db, client)))).toBeInstanceOf(Error)
          expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
          expect(yield* Effect.promise(() => client.request("snapshot"))).toMatchObject({
            revision: 0,
            migration: null,
            rules: [],
          })
          yield* database.db.run(sql`DROP TRIGGER fail_prepare`)
          yield* database.db.run(
            sql`CREATE TRIGGER fail_completion BEFORE UPDATE OF receipt ON permission_handoff BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END`,
          )
          expect(yield* Effect.promise(() => failure(migrate(database.db, client)))).toBeInstanceOf(Error)
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toBeNull()
          expect((yield* PermissionHandoff.requireLegacy(database.db, projectID).pipe(Effect.exit))._tag).toBe(
            "Failure",
          )
          yield* database.db.run(sql`DROP TRIGGER fail_completion`)
          yield* Effect.promise(() => client.request("remove", { id: "legacy-a" }))
          const saved = yield* Effect.promise(() => migrate(database.db, client))
          expect(saved.rules).toHaveLength(2)
          expect(saved.rules.some((item) => item.id === "legacy-a")).toBe(false)
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toEqual(saved.migration)
        }),
      )
    } finally {
      await client.close()
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "a replaced database at the same path cannot receive the original frozen source",
  async () => {
    await using tmp = await tmpdir()
    const storage = path.join(tmp.path, "core.db")
    const native = path.join(tmp.path, "permissions.db")
    const original = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          const snapshot = yield* Effect.promise(() => original.request("snapshot"))
          const authority = Schema.decodeUnknownSync(Schema.Struct({ authority: Schema.String }))(snapshot).authority
          yield* PermissionHandoff.prepare(database.db, { projectID, authority })
        }),
      )
    } finally {
      await original.close()
    }
    await rm(native)
    const replacement = open(native)
    try {
      await run(
        storage,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const before = yield* PermissionHandoff.read(database.db, projectID)
          expect(yield* Effect.promise(() => failure(migrate(database.db, replacement)))).toBeInstanceOf(Error)
          expect(yield* PermissionHandoff.read(database.db, projectID)).toEqual(before)
        }),
      )
      expect(await replacement.request("snapshot")).toMatchObject({ revision: 0, migration: null, rules: [] })
    } finally {
      await replacement.close()
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "missing support, a foreign project and conflicting native receipt do not freeze legacy rules",
  async () => {
    await using tmp = await tmpdir()
    const client = open(path.join(tmp.path, "permissions.db"))
    const foreign = open(path.join(tmp.path, "foreign.db"), "foreign")
    try {
      await run(
        path.join(tmp.path, "core.db"),
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          expect(
            yield* Effect.promise(() =>
              failure(handoffNativeProjectPermissions({ db: database.db, projectID, client, capabilities: {} })),
            ),
          ).toBeInstanceOf(Error)
          expect(yield* Effect.promise(() => failure(migrate(database.db, foreign)))).toBeInstanceOf(Error)
          yield* Effect.promise(() =>
            client.request("migrate", {
              rules: [{ id: "different-source", rule: { action: "read", resource: "other/**", effect: "allow" } }],
            }),
          )
          expect(yield* Effect.promise(() => failure(migrate(database.db, client)))).toBeInstanceOf(Error)
          expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
          yield* PermissionHandoff.requireLegacy(database.db, projectID)
          expect(yield* database.db.select().from(PermissionTable).all()).toHaveLength(3)
        }),
      )
    } finally {
      await Promise.all([client.close(), foreign.close()])
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "two host controllers join the same frozen source without duplicating its native migration",
  async () => {
    await using tmp = await tmpdir()
    const native = path.join(tmp.path, "permissions.db")
    const first = open(native)
    const peer = open(native)
    try {
      await run(
        path.join(tmp.path, "core.db"),
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          const results = yield* Effect.promise(() =>
            Promise.all([migrate(database.db, first), migrate(database.db, peer)]),
          )
          expect(results[0]).toEqual(results[1])
          expect(results[0]!.revision).toBe(1)
          expect(results[0]!.rules).toHaveLength(3)
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toEqual(results[0]!.migration)
        }),
      )
    } finally {
      await Promise.all([first.close(), peer.close()])
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "a peer completing after preflight refreshes the real receipt once without changing destinations",
  async () => {
    await using tmp = await tmpdir()
    const native = path.join(tmp.path, "permissions.db")
    const first = open(native)
    const peer = open(native)
    try {
      await run(
        path.join(tmp.path, "core.db"),
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, tmp.path)
          const observed: string[] = []
          const delayed = {
            request: async (method: string, params?: unknown) => {
              const response = await peer.request(method, params)
              observed.push(method)
              if (method === "snapshot" && observed.length === 1) await migrate(database.db, first)
              return response
            },
          }
          const saved = yield* Effect.promise(() => migrate(database.db, delayed))
          expect(saved.revision).toBe(1)
          expect(saved.rules).toHaveLength(3)
          expect(observed).toEqual(["snapshot", "snapshot", "handoff"])
          expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt).toEqual(saved.migration)
        }),
      )
    } finally {
      await Promise.all([first.close(), peer.close()])
    }
  },
  30_000,
)
