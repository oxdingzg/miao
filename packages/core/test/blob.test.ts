import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const encoder = new TextEncoder()

const withBlob = <A, E, R>(
  body: (input: { root: string; blob: Blob.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([Blob.node, FSUtil.node]), [[Global.node, global]])
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, blob: yield* Blob.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Blob", () => {
  it.live("stores bytes under their sha256 and dedupes identical content", () =>
    withBlob(({ root, blob, fs }) =>
      Effect.gen(function* () {
        const first = yield* blob.put({ bytes: encoder.encode("hello"), mime: "text/plain" })
        expect(first.hash).toHaveLength(64)
        expect(first.bytes).toBe(5)
        expect(first.mime).toBe("text/plain")
        expect(yield* blob.has(first.hash)).toBe(true)

        const second = yield* blob.put({ bytes: encoder.encode("hello") })
        expect(second.hash).toBe(first.hash)

        const directory = path.join(root, Blob.DIRECTORY)
        expect(yield* fs.readFileString(path.join(directory, first.hash))).toBe("hello")
        // Only the final blob remains; the temporary write was renamed away.
        expect((yield* fs.readDirectoryEntries(directory)).map((entry) => entry.name)).toEqual([first.hash])
      }),
    ),
  )

  it.live("returns undefined for a missing blob and removes a stored one", () =>
    withBlob(({ blob }) =>
      Effect.gen(function* () {
        expect(yield* blob.get("0".repeat(64))).toBeUndefined()

        const ref = yield* blob.put({ bytes: new Uint8Array([1, 2, 3]) })
        expect(yield* blob.get(ref.hash)).toEqual(new Uint8Array([1, 2, 3]))

        expect(yield* blob.remove(ref.hash)).toBe(true)
        expect(yield* blob.has(ref.hash)).toBe(false)
        expect(yield* blob.remove(ref.hash)).toBe(false)
      }),
    ),
  )

  it.live("hashes distinct content distinctly", () =>
    withBlob(({ blob }) =>
      Effect.gen(function* () {
        const a = yield* blob.put({ bytes: encoder.encode("a") })
        const b = yield* blob.put({ bytes: encoder.encode("b") })
        expect(a.hash).not.toBe(b.hash)
      }),
    ),
  )
})
