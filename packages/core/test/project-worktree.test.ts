import { afterAll, describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Fiber, Stream } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Global } from "@miao/core/global"
import { Project } from "@miao/core/project"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectTable } from "@miao/core/project/sql"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { AbsolutePath } from "@miao/core/schema"
import { WorktreeEvent } from "@miao/schema/worktree-event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const scopedTmp = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.flatMap((dir) => Effect.promise(() => fs.realpath(dir.path))))

const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "miao-worktree-data-")))
afterAll(() => fs.rm(dataRoot, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ProjectWorktree.node, ProjectDirectories.node, Database.node, EventV2.node]), [
    [Global.node, Global.layerWith({ data: dataRoot })],
  ]),
)

async function initRepo(directory: string) {
  await $`git init -b main`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "README.md"), "hello\n")
  await $`git add README.md && git commit -m root`.cwd(directory).quiet()
}

const projectID = Project.ID.make("prj_worktree")

const setup = Effect.gen(function* () {
  const repo = yield* scopedTmp
  yield* Effect.promise(() => initRepo(repo))
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: projectID,
      worktree: AbsolutePath.make(repo),
      vcs: "git",
      sandboxes: [],
      commands: { start: "touch started.txt" },
      time_created: 1,
      time_updated: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { repo, target: { projectID, checkout: repo, git: true } satisfies ProjectWorktree.Target }
})

const waitFor = (check: () => Promise<boolean>) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await Bun.sleep(50)
    return check()
  })

describe("ProjectWorktree", () => {
  it.live("creates a populated worktree on a miao branch, announces it, and runs the start script", () =>
    Effect.gen(function* () {
      const { repo, target } = yield* setup
      const events = yield* EventV2.Service
      const ready = yield* events.subscribe(WorktreeEvent.Ready).pipe(Stream.take(1), Stream.runHead, Effect.forkScoped)
      const worktrees = yield* ProjectWorktree.Service

      const info = yield* worktrees.create(target, { name: "Feature Work" })

      expect(info.name).toBe("feature-work")
      expect(info.branch).toBe("miao/feature-work")
      expect(info.directory).toBe(path.join(dataRoot, "worktree", projectID, "feature-work"))
      const event = yield* Fiber.join(ready)
      expect(event._tag === "Some" ? String(event.value.location?.directory) : undefined).toBe(info.directory)
      expect(yield* Effect.promise(() => fs.readFile(path.join(info.directory, "README.md"), "utf8"))).toBe("hello\n")
      expect(yield* waitFor(() => Bun.file(path.join(info.directory, "started.txt")).exists())).toBe(true)
      expect((yield* Effect.promise(() => $`git branch --list miao/feature-work`.cwd(repo).text())).trim()).toContain(
        "miao/feature-work",
      )
      const directories = yield* ProjectDirectories.Service
      expect((yield* directories.list(projectID)).map((item) => String(item.directory))).toContain(info.directory)
    }),
  )

  it.live("removes the worktree, its branch, and its registration", () =>
    Effect.gen(function* () {
      const { repo, target } = yield* setup
      const worktrees = yield* ProjectWorktree.Service
      const info = yield* worktrees.create(target)
      yield* waitFor(() => Bun.file(path.join(info.directory, "README.md")).exists())

      expect(yield* worktrees.remove(target, { directory: info.directory })).toBe(true)

      expect(yield* Effect.promise(() => Bun.file(path.join(info.directory, "README.md")).exists())).toBe(false)
      expect((yield* Effect.promise(() => $`git branch --list ${info.branch!}`.cwd(repo).text())).trim()).toBe("")
      const directories = yield* ProjectDirectories.Service
      expect((yield* directories.list(projectID)).map((item) => String(item.directory))).not.toContain(info.directory)
    }),
  )

  it.live("prepares a detached worktree, creates it, and lists it", () =>
    Effect.gen(function* () {
      const { target } = yield* setup
      const worktrees = yield* ProjectWorktree.Service
      const info = yield* worktrees.prepare(target, { detached: true })
      expect(info.branch).toBeUndefined()
      expect(info.directory).toBe(path.join(dataRoot, "worktree", projectID, info.name))

      yield* worktrees.createFromInfo(target, { name: info.name, directory: info.directory })
      expect(yield* waitFor(() => Bun.file(path.join(info.directory, "README.md")).exists())).toBe(true)

      const listed = yield* worktrees.list(target)
      expect(listed.map((item) => item.name)).toContain(info.name)

      expect(yield* worktrees.remove(target, { directory: info.directory })).toBe(true)
    }),
  )

  it.live("resets a worktree to the default branch and refuses the primary checkout", () =>
    Effect.gen(function* () {
      const { repo, target } = yield* setup
      const worktrees = yield* ProjectWorktree.Service
      const info = yield* worktrees.create(target)
      yield* waitFor(() => Bun.file(path.join(info.directory, "README.md")).exists())
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(info.directory, "README.md"), "changed\n")
        await fs.writeFile(path.join(info.directory, "scratch.txt"), "untracked\n")
      })

      expect(yield* worktrees.reset(target, { directory: info.directory })).toBe(true)

      expect(yield* Effect.promise(() => fs.readFile(path.join(info.directory, "README.md"), "utf8"))).toBe("hello\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(info.directory, "scratch.txt")).exists())).toBe(false)
      expect(Exit.isFailure(yield* worktrees.reset(target, { directory: repo }).pipe(Effect.exit))).toBe(true)
    }),
  )
})
