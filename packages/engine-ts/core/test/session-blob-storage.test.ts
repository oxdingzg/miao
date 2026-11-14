import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { Prompt } from "@miao/core/session/prompt"
import { SessionBlobStorage } from "@miao/core/session/blob-storage"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

const withBlob = <A, E, R>(body: (blob: Blob.Interface) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([Blob.node, FSUtil.node]), [[Global.node, global]])
      return Effect.gen(function* () {
        return yield* body(yield* Blob.Service)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("SessionBlobStorage", () => {
  it.live("externalizes an oversized inline attachment", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const base64 = Buffer.alloc(200 * 1024, 1).toString("base64")
        const prompt = Prompt.make({
          text: "see the image",
          files: [{ uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "big.png" }],
        })

        const result = yield* SessionBlobStorage.externalizePromptAttachments(blob, prompt)
        const uri = result.files?.[0]?.uri ?? ""
        expect(Blob.isRef(uri)).toBe(true)
        expect(yield* blob.has(Blob.hashOf(uri) ?? "")).toBe(true)
      }),
    ),
  )

  it.live("keeps a small inline attachment untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const uri = "data:image/png;base64,aGk="
        const prompt = Prompt.make({ text: "see", files: [{ uri, mime: "image/png" }] })
        const result = yield* SessionBlobStorage.externalizePromptAttachments(blob, prompt)
        expect(result.files?.[0]?.uri).toBe(uri)
      }),
    ),
  )

  it.live("externalizes an oversized inline tool-result file", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const base64 = Buffer.alloc(200 * 1024, 2).toString("base64")
        const content = [
          { type: "file" as const, uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "shot.png" },
        ]
        const result = yield* SessionBlobStorage.externalizeToolContent(blob, content)
        const part = result[0]
        const uri = part?.type === "file" ? part.uri : ""
        expect(Blob.isRef(uri)).toBe(true)
        expect(yield* blob.has(Blob.hashOf(uri) ?? "")).toBe(true)
      }),
    ),
  )

  it.live("keeps a small inline tool-result file untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const uri = "data:image/png;base64,aGk="
        const result = yield* SessionBlobStorage.externalizeToolContent(blob, [
          { type: "file" as const, uri, mime: "image/png" },
        ])
        const part = result[0]
        expect(part?.type === "file" ? part.uri : undefined).toBe(uri)
      }),
    ),
  )

  it.live("externalizes an oversized inline structured content field", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const base64 = Buffer.alloc(200 * 1024, 3).toString("base64")
        const structured = { uri: "shot.png", name: "shot.png", encoding: "base64", mime: "image/png", content: base64 }
        const result = yield* SessionBlobStorage.externalizeToolStructured(blob, structured)
        expect(result.contentRef).toBe(true)
        expect(Blob.isRef(result.content as string)).toBe(true)
        expect(yield* blob.has(Blob.hashOf(result.content as string) ?? "")).toBe(true)
        const bytes = yield* blob.get(Blob.hashOf(result.content as string) ?? "").pipe(Effect.orDie)
        expect(bytes?.length).toBe(200 * 1024)
      }),
    ),
  )

  it.live("externalizes an oversized field nested in an array", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const base64 = Buffer.alloc(200 * 1024, 4).toString("base64")
        const structured = { type: "pdf-pages", images: [{ page: 1, mime: "image/jpeg", content: base64 }] }
        const result = yield* SessionBlobStorage.externalizeToolStructured(blob, structured)
        const image = (result.images as Record<string, unknown>[])[0]!
        expect(image.contentRef).toBe(true)
        expect(Blob.isRef(image.content as string)).toBe(true)
      }),
    ),
  )

  it.live("keeps a small structured content field untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const structured = { encoding: "base64", mime: "image/png", content: "aGk=" }
        expect(yield* SessionBlobStorage.externalizeToolStructured(blob, structured)).toEqual(structured)
      }),
    ),
  )
})
