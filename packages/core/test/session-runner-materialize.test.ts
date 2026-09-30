import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { SessionMessage } from "@miao/core/session/message"
import { materializeBlobFiles } from "@miao/core/session/runner/materialize-files"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const encoder = new TextEncoder()
const time = { created: DateTime.makeUnsafe(0) }

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

const user = (files: Array<{ uri: string; mime: string; name?: string }>) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_materialize"),
    type: "user",
    text: "see the file",
    files,
    time,
  })

describe("materializeBlobFiles", () => {
  it.live("resolves a blob reference into a data URI", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "text/plain" })
        const [result] = yield* materializeBlobFiles(blob, [user([{ uri: Blob.refUri(ref.hash), mime: "text/plain", name: "a.txt" }])])
        expect(result?.type === "user" ? result.files?.[0]?.uri : undefined).toBe("data:text/plain;base64,aGk=")
      }),
    ),
  )

  it.live("replaces a missing blob with a text note", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const [result] = yield* materializeBlobFiles(blob, [
          user([{ uri: Blob.refUri("0".repeat(64)), mime: "text/plain", name: "gone.txt" }]),
        ])
        expect(result?.type === "user" ? result.files : "x").toBeUndefined()
        expect(result?.type === "user" ? result.text : "").toContain("attachment unavailable: gone.txt")
      }),
    ),
  )

  it.live("leaves inline data URIs untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const uri = "data:text/plain;base64,aGk="
        const [result] = yield* materializeBlobFiles(blob, [user([{ uri, mime: "text/plain" }])])
        expect(result?.type === "user" ? result.files?.[0]?.uri : undefined).toBe(uri)
      }),
    ),
  )
})
