import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Global } from "@miao/core/global"
import { Location } from "@miao/core/location"
import { AbsolutePath, RelativePath } from "@miao/core/schema"
import { Snapshot } from "@miao/core/snapshot"
import { Hash } from "@miao/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures and restores paths with glob metacharacters", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const weird = path.join(project, "weird*dir")
          yield* Effect.promise(async () => {
            await fs.mkdir(weird, { recursive: true })
            await fs.writeFile(path.join(weird, "a[b].txt"), "one\n")
            await fs.writeFile(path.join(project, ":leading.txt"), "one\n")
            await initGit(project)
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(weird, "a[b].txt"), "two\n")
              await fs.writeFile(path.join(project, ":leading.txt"), "two\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return
            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make(":leading.txt"),
              RelativePath.make("weird*dir/a[b].txt"),
            ])
            const plan = new Map([[RelativePath.make("weird*dir/a[b].txt"), before]])
            expect(yield* snapshot.preview({ files: plan })).toHaveLength(1)
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(weird, "a[b].txt"))).toBe("one\n")
            expect(yield* read(path.join(project, ":leading.txt"))).toBe("two\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures a Location in a project subdirectory named ..foo", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "..foo")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await initGit(project)
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(() => fs.writeFile(path.join(location, "tracked.txt"), "two\n"))
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return
            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("..foo/tracked.txt"),
            ])
          }).pipe(Effect.provide(snapshotLayer(tmp.path, location)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures onto a snapshot store whose directory already exists", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          // A concurrent first capture may have created the store directory before this one.
          const store = path.join(tmp.path, "snapshot", projectID, Hash.fast(project))
          yield* Effect.promise(() => fs.mkdir(store, { recursive: true }))
          const tree = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            return yield* snapshot.capture()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          expect(tree).toBeDefined()
          expect(yield* Effect.promise(() => fs.stat(path.join(store, "HEAD")))).toBeDefined()
          const siblings = yield* Effect.promise(() => fs.readdir(path.join(store, "..")))
          expect(siblings.filter((entry) => entry.includes(".init-"))).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures without leaving temporary index files behind", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          const store = yield* storeDirectory(tmp.path, project)
          const trees = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return []
            yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "two\n"))
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return []
            expect(yield* snapshot.files({ from: before, to: after })).toEqual([RelativePath.make("tracked.txt")])
            return [before, after]
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          expect(trees).toHaveLength(2)
          const entries = yield* Effect.promise(() => fs.readdir(store))
          expect(entries.filter((entry) => entry.startsWith("index.tmp-"))).toEqual([])
          expect(entries).toContain("index")
          expect(entries).toContain("HEAD")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("recovers the next capture from a corrupted snapshot index", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          const store = yield* storeDirectory(tmp.path, project)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(() => fs.writeFile(path.join(store, "index"), "corrupted index"))
            const recovered = yield* snapshot.capture()
            expect(recovered).toBeDefined()
            if (!recovered) return
            expect(yield* snapshot.files({ from: before, to: recovered })).toEqual([])
            yield* Effect.promise(() => fs.writeFile(path.join(project, "added.txt"), "added\n"))
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return
            expect(yield* snapshot.files({ from: recovered, to: after })).toEqual([RelativePath.make("added.txt")])
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          const entries = yield* Effect.promise(() => fs.readdir(store))
          expect(entries.filter((entry) => entry.startsWith("index.tmp-"))).toEqual([])
          expect(entries).toContain("index")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("supports concurrent captures without leftover temporary index files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          const store = yield* storeDirectory(tmp.path, project)
          const trees = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const [first, second] = yield* Effect.all([snapshot.capture(), snapshot.capture()], { concurrency: 2 })
            expect(first).toBeDefined()
            expect(second).toBeDefined()
            if (!first || !second) return []
            expect(yield* snapshot.files({ from: first, to: second })).toEqual([])
            const third = yield* snapshot.capture()
            expect(third).toBeDefined()
            return [first, second, third]
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          expect(trees).toHaveLength(3)
          const entries = yield* Effect.promise(() => fs.readdir(store))
          expect(entries.filter((entry) => entry.startsWith("index.tmp-"))).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("sweeps stale temporary index files when the store initializes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          const store = yield* storeDirectory(tmp.path, project)
          yield* Effect.promise(async () => {
            await fs.mkdir(store, { recursive: true })
            const stale = path.join(store, "index.tmp-old")
            await fs.writeFile(stale, "stale")
            const when = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
            await fs.utimes(stale, when, when)
            await fs.writeFile(path.join(store, "index.tmp-new"), "fresh")
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            expect(yield* snapshot.capture()).toBeDefined()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          const entries = yield* Effect.promise(() => fs.readdir(store))
          expect(entries).not.toContain("index.tmp-old")
          expect(entries).toContain("index.tmp-new")
          expect(entries).toContain("index")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

async function initGit(project: string) {
  await $`git init`.cwd(project).quiet()
  await $`git config core.fsmonitor false`.cwd(project).quiet()
  await $`git config commit.gpgsign false`.cwd(project).quiet()
  await $`git config user.email test@opencode.test`.cwd(project).quiet()
  await $`git config user.name Test`.cwd(project).quiet()
  await $`git add .`.cwd(project).quiet()
  await $`git commit -m initial`.cwd(project).quiet()
}

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function storeDirectory(data: string, directory: string) {
  return Effect.gen(function* () {
    const projectID = yield* Effect.gen(function* () {
      return (yield* Location.Service).project.id
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      ),
    )
    return path.join(data, "snapshot", projectID, Hash.fast(directory))
  })
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}
