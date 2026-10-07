import { afterAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { ProjectV2 } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionHeal } from "@miao/core/session/heal"
import { SessionInputTable } from "@miao/core/session/sql"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionTable } from "@miao/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "miao-heal-data-")))
afterAll(() => fs.rm(dataRoot, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, FSUtil.node, SessionProjector.node]),
    [[Global.node, Global.layerWith({ data: dataRoot })]],
  ),
)

function fixture(slug: string) {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const checkout = AbsolutePath.make(path.join(root.path, "checkout"))
    const missing = AbsolutePath.make(path.join(root.path, "gone-worktree"))
    yield* Effect.promise(() => fs.mkdir(checkout, { recursive: true }))
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const fsService = yield* FSUtil.Service
    const insertProject = (id: ProjectV2.ID, worktree: AbsolutePath) =>
      db
        .insert(ProjectTable)
        .values({ id, worktree, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
    const insertSession = (id: SessionV2.ID, project: ProjectV2.ID, directory: AbsolutePath) =>
      db
        .insert(SessionTable)
        .values({ id, project_id: project, slug, directory, title: slug, version: "test", time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
    const sessionDirectory = (id: SessionV2.ID) =>
      db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie)
    const steers = (id: SessionV2.ID) =>
      db
        .select({ prompt: SessionInputTable.prompt, delivery: SessionInputTable.delivery })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, id))
        .all()
        .pipe(Effect.orDie)
    return {
      root,
      checkout,
      missing,
      db,
      events,
      fsService,
      insertProject,
      insertSession,
      sessionDirectory,
      steers,
    }
  })
}

describe("SessionHeal", () => {
  it.live("relocates a Session whose directory vanished to the project checkout", () =>
    Effect.gen(function* () {
      const env = yield* fixture("relocate")
      const project = ProjectV2.ID.make("prj_heal_relocate")
      const session = SessionV2.ID.make("ses_heal_relocate")
      yield* env.insertProject(project, env.checkout)
      yield* env.insertSession(session, project, env.missing)

      const healed = yield* SessionHeal.relocateOrphan({
        db: env.db,
        events: env.events,
        fs: env.fsService,
        sessionID: session,
        directory: env.missing,
        projectID: project,
      })

      expect(healed).toBe(env.checkout)
      expect((yield* env.sessionDirectory(session))?.directory).toBe(env.checkout)
      // The move must be visible to the model, or it keeps addressing the
      // vanished worktree and every path-based call fails.
      const notices = (yield* env.steers(session)).filter(
        (steer) => steer.delivery === "steer" && JSON.stringify(steer.prompt).includes("system-reminder"),
      )
      expect(notices.length).toBe(1)
      expect(JSON.stringify(notices[0].prompt)).toContain(env.checkout)
    }),
  )

  it.live("does not admit a second notice when a concurrent request already relocated", () =>
    Effect.gen(function* () {
      const env = yield* fixture("relocate_once")
      const project = ProjectV2.ID.make("prj_heal_once")
      const session = SessionV2.ID.make("ses_heal_once")
      yield* env.insertProject(project, env.checkout)
      yield* env.insertSession(session, project, env.missing)

      const input = {
        db: env.db,
        events: env.events,
        fs: env.fsService,
        sessionID: session,
        directory: env.missing,
        projectID: project,
      }
      yield* SessionHeal.relocateOrphan(input)
      // A request that raced the first one re-reads after the row moved and
      // retries; it must find the Session usable without re-notifying.
      const healed = yield* SessionHeal.relocateOrphan(input)

      expect(healed).toBe(env.checkout)
      expect((yield* env.sessionDirectory(session))?.directory).toBe(env.checkout)
      const notices = (yield* env.steers(session)).filter(
        (steer) => steer.delivery === "steer" && JSON.stringify(steer.prompt).includes("system-reminder"),
      )
      expect(notices.length).toBe(1)
    }),
  )

  it.live("returns the directory untouched while it still exists", () =>
    Effect.gen(function* () {
      const env = yield* fixture("live")
      const project = ProjectV2.ID.make("prj_heal_live")
      const session = SessionV2.ID.make("ses_heal_live")
      yield* env.insertProject(project, env.checkout)
      yield* env.insertSession(session, project, env.checkout)

      const healed = yield* SessionHeal.relocateOrphan({
        db: env.db,
        events: env.events,
        fs: env.fsService,
        sessionID: session,
        directory: env.checkout,
        projectID: project,
      })

      expect(healed).toBe(env.checkout)
      expect((yield* env.sessionDirectory(session))?.directory).toBe(env.checkout)
    }),
  )

  it.live("gives up when the project checkout is gone too", () =>
    Effect.gen(function* () {
      const env = yield* fixture("dead")
      const project = ProjectV2.ID.make("prj_heal_dead")
      const session = SessionV2.ID.make("ses_heal_dead")
      yield* env.insertProject(project, AbsolutePath.make(path.join(env.root.path, "deleted-checkout")))
      yield* env.insertSession(session, project, env.missing)

      const healed = yield* SessionHeal.relocateOrphan({
        db: env.db,
        events: env.events,
        fs: env.fsService,
        sessionID: session,
        directory: env.missing,
        projectID: project,
      })

      expect(healed).toBeUndefined()
      expect((yield* env.sessionDirectory(session))?.directory).toBe(env.missing)
    }),
  )
})
