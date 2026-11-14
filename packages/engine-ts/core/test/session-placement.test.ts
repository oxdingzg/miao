import { afterAll, describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Global } from "@miao/core/global"
import { Project } from "@miao/core/project"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionInput } from "@miao/core/session/input"
import { SessionPlacement } from "@miao/core/session/placement"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "miao-placement-data-")))
afterAll(() => fs.rm(dataRoot, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPlacement.node,
      Database.node,
      EventV2.node,
      ProjectDirectories.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
    [[Global.node, Global.layerWith({ data: dataRoot })]],
  ),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

/** A git repo with a registered project and one Session sitting in its primary checkout. */
function fixture(slug: string) {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const checkout = abs(root.path)
    const projectID = (yield* Project.Service.use((service) => service.resolve(checkout))).id
    const sessionID = SessionV2.ID.make(`ses_placement_${slug}`)
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: checkout, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug,
        directory: checkout,
        title: slug,
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const directory = Effect.fnUntraced(function* () {
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row?.directory
    })
    return { root, checkout, projectID, sessionID, db, directory }
  })
}

describe("SessionPlacement", () => {
  it.live("enters a worktree, moves the Session and admits a steer reminder", () =>
    Effect.gen(function* () {
      const f = yield* fixture("enter")
      const placement = yield* SessionPlacement.Service
      const entered = yield* placement.enterWorktree({ sessionID: f.sessionID })

      // The name is generated when the caller omits one, so assert the shape rather than a literal.
      expect(path.dirname(entered.directory)).toBe(path.join(dataRoot, "worktree", f.projectID))
      expect(entered.name).toBe(path.basename(entered.directory))
      expect(entered.branch).toBe(`miao/${entered.name}`)
      expect(yield* Effect.promise(() => fs.readFile(path.join(entered.directory, "tracked.txt"), "utf8"))).toBe(
        "initial\n",
      )
      expect(yield* f.directory()).toBe(entered.directory)

      const pending = yield* SessionInput.pending(f.db, { sessionID: f.sessionID, limit: 10 })
      expect(pending.inputs).toHaveLength(1)
      expect(pending.inputs[0].delivery).toBe("steer")
      expect(pending.inputs[0].prompt.text).toContain(`worktree "${entered.name}" at "${entered.directory}"`)
    }),
  )

  it.live("exits a worktree it keeps on disk", () =>
    Effect.gen(function* () {
      const f = yield* fixture("keep")
      const placement = yield* SessionPlacement.Service
      const entered = yield* placement.enterWorktree({ sessionID: f.sessionID, name: "kept" })

      expect(yield* placement.exitWorktree({ sessionID: f.sessionID, action: "keep" })).toEqual({
        directory: f.checkout,
        removed: false,
      })
      expect(yield* f.directory()).toBe(f.checkout)
      expect(yield* Effect.promise(() => Bun.file(path.join(entered.directory, "tracked.txt")).exists())).toBe(true)
    }),
  )

  it.live("exits a worktree it removes together with its branch", () =>
    Effect.gen(function* () {
      const f = yield* fixture("remove")
      const placement = yield* SessionPlacement.Service
      const entered = yield* placement.enterWorktree({ sessionID: f.sessionID, name: "gone" })

      expect(yield* placement.exitWorktree({ sessionID: f.sessionID, action: "remove" })).toEqual({
        directory: f.checkout,
        removed: true,
      })
      expect(yield* f.directory()).toBe(f.checkout)
      expect(yield* Effect.promise(() => Bun.file(entered.directory).exists())).toBe(false)
      expect(
        (yield* Effect.promise(() => $`git branch --list ${entered.branch!}`.cwd(f.checkout).text())).trim(),
      ).toBe("")
    }),
  )

  it.live("refuses to exit a Session that is already in the primary checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture("already")
      const placement = yield* SessionPlacement.Service
      const error = yield* placement.exitWorktree({ sessionID: f.sessionID, action: "keep" }).pipe(Effect.flip)

      expect(error._tag).toBe("SessionPlacement.Error")
      expect(error.message).toContain("already in the project's primary checkout")
    }),
  )
})
