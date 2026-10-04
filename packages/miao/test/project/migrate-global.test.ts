import { describe, expect } from "bun:test"
import { Project } from "@miao/schema/project"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { ProjectRegistry } from "@miao/core/project/registry"
import { projectTestNode } from "../fixture/project-node"
import { Database } from "@miao/core/database/database"
import { eq } from "drizzle-orm"
import { SessionTable } from "@miao/core/session/sql"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { ProjectV2 } from "@miao/core/project"
import { SessionV2 } from "@miao/core/session"
import { $ } from "bun"
import { tmpdirScoped } from "../fixture/fixture"
import { LayerNode } from "@miao/core/effect/layer-node"
import { CrossSpawnSpawner } from "@miao/core/cross-spawn-spawner"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(projectTestNode))

function legacySessionID() {
  // Global-session migration covers persisted IDs from before prefixed session IDs.
  return crypto.randomUUID() as SessionV2.ID
}

function seed(opts: { id: SessionV2.ID; dir: string; project: ProjectV2.ID }) {
  const now = Date.now()
  return Database.Service.use(({ db }) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: opts.project,
        slug: opts.id,
        directory: opts.dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie),
  )
}

function ensureGlobal() {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make("/"),
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

describe("migrateFromGlobal", () => {
  it.live("migrates global sessions on first project creation", () =>
    Effect.gen(function* () {
      // 1. Start with git init but no commits — creates "global" project row
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.name "Test"`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.email "test@opencode.test"`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(tmp).quiet())
      const { project: pre } = yield* ProjectRegistry.registerDirectory(tmp)
      expect(pre.id).toBe(ProjectV2.ID.global)

      // 2. Seed a session under "global" with matching directory
      const id = legacySessionID()
      yield* seed({ id, dir: tmp, project: ProjectV2.ID.global })

      // 3. Make a commit so the project gets a real ID
      yield* Effect.promise(() => $`git commit --allow-empty -m "root"`.cwd(tmp).quiet())

      const { project: real } = yield* ProjectRegistry.registerDirectory(tmp)
      expect(real.id).not.toBe(ProjectV2.ID.global)

      // 4. The session should have been migrated to the real project ID
      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
      )
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(real.id)
    }),
  )

  it.live("migrates global sessions even when project row already exists", () =>
    Effect.gen(function* () {
      // 1. Create a repo with a commit — real project ID created immediately
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* ProjectRegistry.registerDirectory(tmp)
      expect(project.id).not.toBe(ProjectV2.ID.global)

      // 2. Ensure "global" project row exists (as it would from a prior no-git session)
      yield* ensureGlobal()

      // 3. Seed a session under "global" with matching directory.
      //    This simulates a session created before git init that wasn't
      //    present when the real project row was first created.
      const id = legacySessionID()
      yield* seed({ id, dir: tmp, project: ProjectV2.ID.global })

      // 4. Call fromDirectory again — project row already exists,
      //    so the current code skips migration entirely. This is the bug.
      yield* ProjectRegistry.registerDirectory(tmp)

      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
      )
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(project.id)
    }),
  )

  it.live("does not claim sessions with empty directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* ProjectRegistry.registerDirectory(tmp)
      expect(project.id).not.toBe(ProjectV2.ID.global)

      yield* ensureGlobal()

      // Legacy sessions may lack a directory value.
      // Without a matching origin directory, they should remain global.
      const id = legacySessionID()
      yield* seed({ id, dir: "", project: ProjectV2.ID.global })

      yield* ProjectRegistry.registerDirectory(tmp)

      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
      )
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(ProjectV2.ID.global)
    }),
  )

  it.live("does not steal sessions from unrelated directories", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* ProjectRegistry.registerDirectory(tmp)
      expect(project.id).not.toBe(ProjectV2.ID.global)

      yield* ensureGlobal()

      // Seed a session under "global" but for a DIFFERENT directory
      const id = legacySessionID()
      yield* seed({ id, dir: "/some/other/dir", project: ProjectV2.ID.global })

      yield* ProjectRegistry.registerDirectory(tmp)
      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
      )
      expect(row).toBeDefined()
      // Should remain under "global" — not stolen
      expect(row!.project_id).toBe(ProjectV2.ID.global)
    }),
  )
})
