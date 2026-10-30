import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Database } from "@miao/core/database/database"
import { PermissionHandoff } from "@miao/core/permission/handoff"
import { PermissionTable } from "@miao/core/permission/sql"
import { PermissionSaved } from "@miao/core/permission/saved"
import { ProjectV2 } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { EngineClient } from "@/engine/client"
import { NativePermissionContext } from "@/engine/native-permission-context"
import { prepareSharedPermissionOwner } from "@/engine/native-shared-permission-startup"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const projectID = ProjectV2.ID.make("fixture-project")
const run = <A, E>(storage: string, effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(storage)), Effect.scoped))
const seed = Effect.fn(function* (db: Database.Interface["db"], directory: string) {
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .run()
  yield* db
    .insert(PermissionTable)
    .values({
      id: PermissionSaved.ID.make("psv_legacy_fixture"),
      project_id: projectID,
      action: "read",
      resource: "legacy/**",
    })
    .run()
})

const failure = (value: Promise<unknown>) =>
  value.then(
    () => undefined,
    (error: unknown) => error,
  )

test.skipIf(!binary)(
  "managed paired startup completes both receipts and exact retries preserve Root revocation",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    const input = {
      binary: binary!,
      directory: workspace,
      source: path.join(tmp.path, "source.db"),
      root: path.join(tmp.path, "permissions.db"),
      projectID,
    }
    await run(
      path.join(tmp.path, "core.db"),
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database.db, workspace)
        const paired = yield* Effect.promise(() => prepareSharedPermissionOwner({ ...input, db: database.db }))
        expect(paired.snapshot.project.migration?.imported).toBe(1)
        expect(paired.snapshot.migration?.imported).toBe(0)
        expect((yield* PermissionHandoff.read(database.db, projectID))?.receipt?.imported).toBe(1)
        const client = EngineClient.start({
          binary: binary!,
          db: input.source,
          workspace,
          model: "fixture",
          provider: "openai-chat",
          endpoint: "http://127.0.0.1:9",
          env: { OPENAI_API_KEY: "fixture-only" },
          ...paired.options,
        })
        try {
          expect(client.sharedPermission?.project).toBe(projectID)
          const observed = Schema.decodeUnknownSync(NativePermissionContext.Observation)(
            yield* Effect.promise(() => client.request("shared_permission_snapshot")),
          )
          expect(NativePermissionContext.saved(observed.snapshot, projectID)).toEqual([
            { id: PermissionSaved.ID.make("psv_legacy_fixture"), projectID, action: "read", resource: "legacy/**" },
          ])
          yield* Effect.promise(() => client.request("permission_saved_remove", { id: PermissionSaved.ID.make("psv_legacy_fixture") }))
        } finally {
          yield* Effect.promise(() => client.close())
        }
        const retried = yield* Effect.promise(() => prepareSharedPermissionOwner({ ...input, db: database.db }))
        expect(retried.snapshot.project.rules).toEqual([])
        expect(retried.snapshot.project.migration?.imported).toBe(1)
      }),
    )
  },
  30_000,
)

test.skipIf(!binary)(
  "a model-writable Root is refused before either source is frozen",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    const source = path.join(tmp.path, "source.db")
    await run(
      path.join(tmp.path, "core.db"),
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database.db, workspace)
        const error = yield* Effect.promise(() =>
          failure(
            prepareSharedPermissionOwner({
              binary: binary!,
              source,
              root: path.join(workspace, "permissions.db"),
              directory: workspace,
              projectID,
              db: database.db,
            }),
          ),
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toContain("outside the workspace")
        expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(source).exists())).toBe(false)
      }),
    )
  },
  30_000,
)

test.skipIf(!binary)(
  "an active legacy native run blocks paired migration before Core freezes",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    const source = path.join(tmp.path, "source.db")
    const entered = Promise.withResolvers<void>()
    const server = Bun.serve({
      port: 0,
      fetch() {
        entered.resolve()
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const client = EngineClient.start({
      binary: binary!,
      db: source,
      workspace,
      model: "fixture",
      provider: "openai-chat",
      endpoint: server.url.toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    try {
      await client.admit({ session_id: "old", input_id: "one", prompt: "hold", delivery: "steer" }, true)
      await entered.promise
      await run(
        path.join(tmp.path, "core.db"),
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* seed(database.db, workspace)
          const error = yield* Effect.promise(() =>
            failure(
              prepareSharedPermissionOwner({
                binary: binary!,
                source,
                root: path.join(tmp.path, "permissions.db"),
                directory: workspace,
                projectID,
                db: database.db,
              }),
            ),
          )
          expect(error).toBeInstanceOf(Error)
          expect(yield* PermissionHandoff.read(database.db, projectID)).toBeUndefined()
        }),
      )
    } finally {
      await client.close()
      server.stop(true)
    }
  },
  30_000,
)
