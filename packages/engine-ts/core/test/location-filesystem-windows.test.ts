import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { FileSystem } from "../src/filesystem"
import { Location } from "../src/location"
import { AbsolutePath, RelativePath } from "../src/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const windows = process.platform === "win32" ? it.live : it.live.skip
const uncRoot = process.env.MIAO_TEST_UNC_ROOT
const unc = process.platform === "win32" && uncRoot ? it.live : it.live.skip

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

windows("Windows location reads preserve Unicode through drive and case aliases", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "Case-路径")))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "Case-路径", "café-文件.txt"), "Unicode fixture"))
      const filesystem = yield* FileSystem.Service
      const result = yield* filesystem.read({ path: RelativePath.make("CASE-路径/CAFÉ-文件.TXT") })
      expect(new TextDecoder().decode(result.content)).toBe("Unicode fixture")
    }).pipe(provide(directory.toLowerCase())),
  ),
)

windows("Windows location keeps distinct Unicode-normalization filenames distinct", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "café.txt"), "composed", { flag: "wx" }))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "cafe\u0301.txt"), "decomposed", { flag: "wx" }))
      const filesystem = yield* FileSystem.Service
      const first = yield* filesystem.read({ path: RelativePath.make("café.txt") })
      const second = yield* filesystem.read({ path: RelativePath.make("cafe\u0301.txt") })
      expect(new TextDecoder().decode(first.content)).toBe("composed")
      expect(new TextDecoder().decode(second.content)).toBe("decomposed")
    }).pipe(provide(directory)),
  ),
)

windows("Windows location allows a junction whose target remains inside the location", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "inside")))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "inside", "file.txt"), "inside"))
      yield* Effect.promise(() =>
        fs.symlink(path.join(directory, "inside"), path.join(directory, "linked"), "junction"),
      )
      const filesystem = yield* FileSystem.Service
      const result = yield* filesystem.read({ path: RelativePath.make("linked/file.txt") })
      expect(new TextDecoder().decode(result.content)).toBe("inside")
    }).pipe(provide(directory)),
  ),
)

windows("Windows location rejects reads and listings through an escaping junction", () =>
  withTmp((directory) =>
    withTmp((outside) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(outside, "protected.txt"), "outside"))
        yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "linked"), "junction"))
        const filesystem = yield* FileSystem.Service
        expect(
          Exit.isFailure(yield* filesystem.read({ path: RelativePath.make("linked/protected.txt") }).pipe(Effect.exit)),
        ).toBe(true)
        expect(Exit.isFailure(yield* filesystem.list({ path: RelativePath.make("linked") }).pipe(Effect.exit))).toBe(
          true,
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "protected.txt"), "utf8"))).toBe("outside")
      }).pipe(provide(directory)),
    ),
  ),
)

windows("Windows location reads a file beyond the legacy 260-character path limit", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      const relative = path.join(...Array.from({ length: 8 }, (_, i) => `segment-${i}-${"x".repeat(32)}`))
      yield* Effect.promise(() => fs.mkdir(path.join(directory, relative), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, relative, "文件.txt"), "long path"))
      expect(path.join(directory, relative, "文件.txt").length).toBeGreaterThan(260)
      const filesystem = yield* FileSystem.Service
      const result = yield* filesystem.read({ path: RelativePath.make(path.join(relative, "文件.txt")) })
      expect(new TextDecoder().decode(result.content)).toBe("long path")
    }).pipe(provide(directory)),
  ),
)

windows("Windows location accepts an extended-length drive root", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "file.txt"), "namespaced root"))
      const filesystem = yield* FileSystem.Service
      const result = yield* filesystem.read({ path: RelativePath.make("file.txt") })
      expect(new TextDecoder().decode(result.content)).toBe("namespaced root")
    }).pipe(provide(path.toNamespacedPath(directory))),
  ),
)

// Set only to a writable test share; no share or machine policy is created here.
unc("Windows location reads through an actual UNC share", () => {
  if (!uncRoot) return Effect.die(new Error("MIAO_TEST_UNC_ROOT is required"))
  return Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(uncRoot, "miao-location-"))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "文件.txt"), "UNC fixture"))
        const filesystem = yield* FileSystem.Service
        const result = yield* filesystem.read({ path: RelativePath.make("文件.txt") })
        expect(new TextDecoder().decode(result.content)).toBe("UNC fixture")
      }).pipe(provide(directory)),
    ),
  )
})
