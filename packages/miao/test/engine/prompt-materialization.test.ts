import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit, Layer } from "effect"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { PromptMaterialization } from "../../src/engine/prompt-materialization"
import { decodeAttachments, encodeAttachments } from "../../src/engine/prompt-attachments"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.empty)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
)
const withStorage = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R | Blob.Service | FSUtil.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (directory) =>
      body(directory.path).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Blob.node, FSUtil.node]), [
            [Global.node, Global.layerWith({ data: directory.path })],
          ]),
        ),
      ),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  )

it.live("snapshots file and blob image references and preserves presentation metadata", () =>
  withStorage((root) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const blob = yield* Blob.Service
      const filename = path.join(root, "image with spaces.png")
      yield* fs.writeFile(filename, png)
      const stored = yield* blob.put({ bytes: png })
      const prompt = yield* PromptMaterialization.prepare({
        text: "inspect",
        files: [
          { uri: pathToFileURL(filename).href, name: "chosen", path: filename, description: "description" },
          { uri: Blob.refUri(stored.hash), name: "blob" },
        ],
      })
      expect(prompt.files?.map((file) => file.uri)).toEqual([
        `data:image/png;base64,${png.toString("base64")}`,
        `data:image/png;base64,${png.toString("base64")}`,
      ])
      expect(encodeAttachments(prompt.files)[0]?.metadata).toEqual({
        name: "chosen",
        path: filename,
        description: "description",
      })
      yield* fs.writeFile(filename, new Uint8Array())
      yield* blob.remove(stored.hash)
      expect(encodeAttachments(prompt.files).map((file) => file.data)).toEqual([
        png.toString("base64"),
        png.toString("base64"),
      ])
    }),
  ),
)

it.live("downloads real HTTP images, follows redirects and bounds chunked bodies independently of headers", () =>
  withStorage(() =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname === "/redirect") return Response.redirect(new URL("/image", url), 302)
              if (url.pathname === "/status") return new Response("missing", { status: 404 })
              if (url.pathname === "/large")
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(Buffer.alloc(6 * 1024 * 1024))
                      controller.enqueue(Buffer.alloc(1))
                      controller.close()
                    },
                  }),
                )
              return new Response(png, { headers: { "content-type": "text/plain" } })
            },
          }),
        ),
        (server) =>
          Effect.sync(() => {
            server.stop(true)
          }),
      )
      const good = yield* PromptMaterialization.prepare({
        text: "",
        files: [{ uri: new URL("/redirect", server.url).href }],
      })
      expect(good.files?.[0]?.uri).toBe(`data:image/png;base64,${png.toString("base64")}`)
      for (const pathname of ["/status", "/large"]) {
        const exit = yield* PromptMaterialization.prepare({
          text: "",
          files: [{ uri: new URL(pathname, server.url).href }],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }),
  ),
)

it.live("rejects missing, oversized or invalid references before admission and leaves inline input stable", () =>
  withStorage((root) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const blob = yield* Blob.Service
      const filename = path.join(root, "large.png")
      const large = Buffer.alloc(6 * 1024 * 1024 + 1)
      png.copy(large)
      yield* fs.writeFile(filename, large)
      const stored = yield* blob.put({ bytes: large })
      const invalid = [
        pathToFileURL(filename).href,
        Blob.refUri(stored.hash),
        Blob.refUri("0".repeat(64)),
        "blob://../escape",
        pathToFileURL(root).href,
        "ftp://example.invalid/image.png",
      ]
      for (const uri of invalid)
        expect(
          Exit.isFailure(yield* PromptMaterialization.prepare({ text: "", files: [{ uri }] }).pipe(Effect.exit)),
        ).toBe(true)
      const attachment = { uri: `data:image/png;base64,${png.toString("base64")}` }
      const inline = { text: "", files: [attachment] }
      expect(yield* PromptMaterialization.prepare(inline)).toEqual(inline)
      expect(
        Exit.isFailure(
          yield* PromptMaterialization.prepare({
            text: "",
            files: Array.from({ length: 9 }, () => attachment),
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const exact = yield* blob.put({ bytes: new Uint8Array([1, 2, 3]) })
      expect(yield* blob.get(exact.hash, 3)).toEqual(new Uint8Array([1, 2, 3]))
      expect(Exit.isFailure(yield* blob.get(exact.hash, 2).pipe(Effect.exit))).toBe(true)
    }),
  ),
)

it.live("snapshots PDF and UTF-8 text references, including empty files, with replayable metadata", () =>
  withStorage((root) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const blob = yield* Blob.Service
      const pdf = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n")
      const filename = path.join(root, "document.pdf")
      const empty = path.join(root, "empty.txt")
      yield* fs.writeFile(filename, pdf)
      yield* fs.writeFile(empty, new Uint8Array())
      const text = yield* blob.put({ bytes: Buffer.from("# 文档\nattached text") })
      const prompt = yield* PromptMaterialization.prepare({
        text: "inspect",
        files: [
          { uri: pathToFileURL(filename).href, name: "document.pdf", path: filename },
          { uri: Blob.refUri(text.hash), name: "notes.md" },
          { uri: pathToFileURL(empty).href, name: "empty.txt" },
        ],
      })
      const encoded = encodeAttachments(prompt.files)
      expect(encoded.map((file) => file.mime)).toEqual(["application/pdf", "text/plain", "text/plain"])
      expect(encoded[0]?.data).toBe(pdf.toString("base64"))
      expect(encoded[2]?.data).toBe("")
      expect(decodeAttachments(encoded).map((file) => ({ uri: file.uri, name: file.name }))).toEqual(
        (prompt.files ?? []).map((file) => ({ uri: file.uri, name: file.name })),
      )
      expect(encodeAttachments([{ uri: "data:text/markdown;charset=utf-8;base64,IyBoaQ==" }])[0]?.mime).toBe(
        "text/markdown",
      )
    }),
  ),
)
