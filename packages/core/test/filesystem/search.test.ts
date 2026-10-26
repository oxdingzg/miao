import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "node:os"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FileSystemSearch } from "@miao/core/filesystem/search"
import { Location } from "@miao/core/location"
import { Ripgrep } from "@miao/core/ripgrep"
import { AbsolutePath, RelativePath } from "@miao/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

describe("fff", () => {
  const layer = (directory: AbsolutePath) =>
    FileSystemSearch.fffLayer.pipe(
      Layer.provide(Layer.succeed(Location.Service, Location.Service.of(location({ directory })))),
    )

  test("a Location whose directory is gone searches nothing and does not warn", async () => {
    const messages: string[] = []
    const logger = Logger.make<unknown, void>((options) => {
      messages.push(String(options.message))
    })
    const directory = AbsolutePath.make(path.join(os.tmpdir(), `miao-directory-gone-${crypto.randomUUID()}`))
    const found = await Effect.gen(function* () {
      const search = yield* FileSystemSearch.Service
      return [yield* search.find({ query: "readme" }), yield* search.glob({ pattern: "*.ts" })]
    }).pipe(
      Effect.provide(layer(directory)),
      Effect.provide(Logger.layer([logger])),
      Effect.runPromise,
    )
    expect(found).toEqual([[], []])
    expect(messages.filter((message) => message.includes("failed to initialize fff"))).toEqual([])
  })
})
