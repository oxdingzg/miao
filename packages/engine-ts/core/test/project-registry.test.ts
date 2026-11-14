import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { Project } from "@miao/core/project"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { ProjectRegistry } from "@miao/core/project/registry"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionTable } from "@miao/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Project.node,
      ProjectDirectories.node,
      ProjectMetadata.node,
      Database.node,
      EventV2.node,
      FSUtil.node,
    ]),
  ),
)

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

const scopedTmp = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.flatMap((dir) => Effect.promise(() => fs.realpath(dir.path))))

// Resolve a directory the way a location does, then register what it resolved to.
const open = Effect.fnUntraced(function* (directory: string) {
  const projects = yield* Project.Service
  const resolved = yield* projects.resolve(AbsolutePath.make(directory))
  return yield* ProjectRegistry.register({
    id: resolved.id,
    previous: resolved.previous === resolved.id ? undefined : resolved.previous,
    directory: resolved.directory,
    vcs: resolved.vcs,
  })
})

const insertSession = (id: string, projectID: Project.ID, directory: string) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionTable)
      .values({
        id: id as never,
        project_id: projectID,
        slug: id,
        directory: AbsolutePath.make(directory),
        title: id,
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie),
  )

const sessionProject = (id: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({ project: SessionTable.project_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, id as never))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.project),
      ),
  )

describe("ProjectRegistry.register", () => {
  it.live("records the project, its directory, and a second checkout as a sandbox", () =>
    Effect.gen(function* () {
      const root = yield* scopedTmp
      const repo = path.join(root, "repo")
      const checkout = path.join(root, "checkout")
      yield* Effect.promise(async () => {
        await fs.mkdir(repo)
        await initRepo(repo)
        await $`git worktree add ${checkout} -b feature`.cwd(repo).quiet()
      })

      const first = yield* open(repo)
      expect(first.worktree).toBe(repo)
      expect(first.vcs).toBe("git")

      const second = yield* open(checkout)
      expect(second.id).toBe(first.id)
      expect(second.worktree).toBe(repo)
      expect(second.sandboxes).toEqual([checkout])

      const directories = yield* ProjectDirectories.Service
      expect((yield* directories.list(first.id)).map((item) => String(item.directory)).toSorted()).toEqual(
        [repo, checkout].toSorted(),
      )
      // The repository caches its project ID for the next resolution.
      expect((yield* Effect.promise(() => fs.readFile(path.join(repo, ".git", "opencode"), "utf8"))).trim()).toBe(
        first.id,
      )
    }),
  )

  it.live("moves sessions to the new ID when a repository gains a remote", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmp
      yield* Effect.promise(() => initRepo(repo))
      const before = yield* open(repo)
      yield* insertSession("ses_moved", before.id, repo)
      yield* ProjectMetadata.Service.use((metadata) => metadata.update(before.id, { name: "Named" }))

      yield* Effect.promise(() => $`git remote add origin https://example.test/team/repo.git`.cwd(repo).quiet())
      const after = yield* open(repo)

      expect(after.id).not.toBe(before.id)
      expect(after.name).toBe("Named")
      expect(yield* sessionProject("ses_moved")).toBe(after.id)
      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, before.id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.live("adopts sessions filed under the global project once the directory becomes a repository", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmp
      expect((yield* open(repo)).id).toBe(Project.ID.global)
      yield* insertSession("ses_global", Project.ID.global, repo)
      yield* Effect.promise(() => initRepo(repo))

      const project = yield* open(repo)

      expect(project.id).not.toBe(Project.ID.global)
      expect(yield* sessionProject("ses_global")).toBe(project.id)
    }),
  )

  it.live("uses the shortest favicon as the icon of a git project without one", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmp
      yield* Effect.promise(async () => {
        await initRepo(repo)
        await fs.mkdir(path.join(repo, "web", "public"), { recursive: true })
        await fs.writeFile(path.join(repo, "favicon.svg"), "<svg/>")
        await fs.writeFile(path.join(repo, "web", "public", "favicon.png"), "png")
      })
      const project = yield* open(repo)

      yield* ProjectRegistry.discoverIcon(project)

      const metadata = yield* ProjectMetadata.Service
      const stored = (yield* metadata.list()).find((item) => item.id === project.id)
      expect(stored?.icon?.url).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`)
    }),
  )
})
