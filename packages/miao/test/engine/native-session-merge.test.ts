import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AbsolutePath } from "@miao/core/schema"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionID } from "@miao/schema/session-id"
import { Project } from "@miao/schema/project"
import { mergeNativeSessions } from "@miao/server/native-session"
import { tmpdir } from "../fixture/fixture"

/**
 * A placement outlives its Location when a worktree is deleted out-of-band or a
 * smoke-test workspace under /tmp disappears. Opening that Location dies in
 * `realPath`; listing must keep serving every other Session instead of turning
 * the whole page into a 500.
 */
test("an unreadable native Location does not fail the session listing", async () => {
  await using tmp = await tmpdir()
  const healthy = AbsolutePath.make(path.join(tmp.path, "healthy"))
  await Bun.write(path.join(healthy, ".keep"), "")
  const vanished = AbsolutePath.make(path.join(tmp.path, "vanished"))
  const broken = AbsolutePath.make(path.join(tmp.path, "broken"))
  const storage = path.join(tmp.path, "product.db")

  const result = await Effect.gen(function* () {
    const database = yield* Database.Service
    for (const [sessionID, directory] of [
      [SessionID.make("ses_healthy"), healthy],
      [SessionID.make("ses_vanished"), vanished],
      [SessionID.make("ses_broken"), broken],
    ] as const) {
      yield* SessionEnginePlacement.claim(database.db, {
        sessionID,
        placement: {
          engine: "rust",
          storage: AbsolutePath.make(path.join(tmp.path, `${sessionID}.db`)),
          location: { directory },
        },
      })
    }
    return yield* mergeNativeSessions({
      native: {
        snapshot: (input) => {
          expect(input.metadataOnly).toBe(true)
          return input.location.directory === broken
            ? Effect.die(new Error("engine child died"))
            : Effect.succeed({ session_id: input.sessionID, title: "kept", created_at_ms: 1, updated_at_ms: 2 })
        },
        usage: () => Effect.succeed({}),
      },
      db: database.db,
      sessions: [],
      limit: 10,
      order: "desc",
      // A Location whose directory vanished fails during resolution, the way
      // `Project.resolve` dies on `realPath` before an engine child is spawned.
      projects: {
        resolve: (directory: AbsolutePath) =>
          directory === vanished
            ? Effect.die(new Error(`realPath: ${directory} does not exist`))
            : Effect.succeed({ id: Project.ID.global }),
      },
    })
  }).pipe(Effect.provide(Database.layerFromPath(storage)), Effect.runPromise)

  expect(result.map((session) => session.id)).toEqual([SessionID.make("ses_healthy")])
  expect(result[0]?.title).toBe("kept")
})

test("one missing native Session does not hide healthy siblings in the same storage", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(tmp.path)
  const nativeStorage = AbsolutePath.make(path.join(tmp.path, "native.db"))
  const result = await Effect.gen(function* () {
    const database = yield* Database.Service
    for (const id of ["ses_healthy", "ses_missing", "ses_later"]) {
      yield* SessionEnginePlacement.claim(database.db, {
        sessionID: SessionID.make(id),
        placement: { engine: "rust", storage: nativeStorage, location: { directory } },
      })
    }
    return yield* mergeNativeSessions({
      native: {
        snapshot: (input) =>
          input.sessionID === "ses_missing"
            ? Effect.die(new Error("Session does not exist"))
            : Effect.succeed({
                session_id: input.sessionID,
                title: input.sessionID,
                created_at_ms: 1,
                updated_at_ms: 2,
              }),
        usage: () => Effect.succeed({}),
      },
      db: database.db,
      sessions: [],
      limit: 10,
      order: "desc",
      projects: { resolve: () => Effect.succeed({ id: Project.ID.global }) },
    })
  }).pipe(Effect.provide(Database.layerFromPath(path.join(tmp.path, "product.db"))), Effect.runPromise)
  expect(result.map((session) => session.id).sort()).toEqual(["ses_healthy", "ses_later"])
})
