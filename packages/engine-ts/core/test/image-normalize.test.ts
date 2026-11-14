import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@miao/core/config"
import { ConfigAttachments } from "@miao/core/config/attachments"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Image } from "@miao/core/image"
import { SessionImageNormalize } from "@miao/core/session/image-normalize"

const TRANSPARENT_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const TARGET_RAW_BYTES = 512_000

// Declared locally rather than imported from the adapter: fixtures must not be
// built by the same surface the tests are checking.
interface BunImageHandle {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(width: number, height: number, options: { readonly fit: "fill" }): BunImageHandle
  jpeg(options: { readonly quality: number }): BunImageHandle
  png(): BunImageHandle
  toBuffer(): Promise<Uint8Array>
}

const BunImage = (globalThis as unknown as { Bun: { Image: new (input: Uint8Array) => BunImageHandle } }).Bun.Image

type ImageConfig = InstanceType<typeof ConfigAttachments.Image>

const layer = (image?: ImageConfig) =>
  AppNodeBuilder.build(Image.node, [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.succeed(
              image === undefined
                ? []
                : [
                    new Config.Document({
                      type: "document",
                      info: new Config.Info({ attachments: new ConfigAttachments.Info({ image }) }),
                    }),
                  ],
            ),
        }),
      ),
    ],
  ])

/**
 * A solid source that is genuinely opaque: routing the transparent pixel through
 * JPEG strips the alpha channel, so the re-encoded PNG reports colour type 2 or
 * a palette with no `tRNS`.
 */
const opaque = async (width: number, height: number) => {
  const decoded = new BunImage(Buffer.from(TRANSPARENT_PIXEL, "base64")).resize(width, height, { fit: "fill" })
  return Buffer.from(await new BunImage(await decoded.jpeg({ quality: 95 }).toBuffer()).png().toBuffer())
}

const withImage = <A>(
  run: (image: Image.Interface) => Effect.Effect<A>,
  config?: ImageConfig,
): Promise<A> => Effect.runPromise(Effect.gen(function* () {
  return yield* run(yield* Image.Service)
}).pipe(Effect.provide(layer(config))))

const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`

const decoded = (uri: string) => Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64")

describe("SessionImageNormalize.promptInput", () => {
  it("shrinks an oversized attachment and repoints its uri", async () => {
    const source = await opaque(2_400, 1_600)
    const prompt = { text: "look", files: [{ uri: dataUri("image/png", source) }] }
    const result = await withImage((image) => SessionImageNormalize.promptInput(image, prompt))
    expect(result.files?.[0]?.uri.startsWith("data:image/jpeg;base64,")).toBe(true)
    expect(decoded(result.files![0]!.uri).length).toBeLessThanOrEqual(TARGET_RAW_BYTES)
    expect(result.text).toBe("look")
  })

  it("returns an attachment that already fits untouched", async () => {
    const uri = dataUri("image/png", await opaque(8, 8))
    const result = await withImage((image) => SessionImageNormalize.promptInput(image, { text: "look", files: [{ uri }] }))
    expect(result.files?.[0]?.uri).toBe(uri)
  })

  it("ignores attachments that are not inline data", async () => {
    const result = await withImage((image) =>
      SessionImageNormalize.promptInput(image, { text: "look", files: [{ uri: "file:///tmp/a.png" }] }),
    )
    expect(result.files?.[0]?.uri).toBe("file:///tmp/a.png")
  })

  it("keeps undecodable bytes rather than failing the prompt", async () => {
    const uri = dataUri("image/png", Buffer.from("not an image at all"))
    const result = await withImage((image) => SessionImageNormalize.promptInput(image, { text: "look", files: [{ uri }] }))
    expect(result.files?.[0]?.uri).toBe(uri)
  })
})

describe("SessionImageNormalize.toolContent", () => {
  it("shrinks an oversized image part", async () => {
    const source = await opaque(2_400, 1_600)
    const content = [{ type: "file" as const, uri: dataUri("image/png", source), mime: "image/png", name: "shot.png" }]
    const result = await withImage((image) => SessionImageNormalize.toolContent(image, content))
    expect(result[0]?.type).toBe("file")
    if (result[0]?.type !== "file") return
    expect(result[0].name).toBe("shot.png")
    expect(result[0].mime).toBe("image/jpeg")
    expect(decoded(result[0].uri).length).toBeLessThanOrEqual(TARGET_RAW_BYTES)
  })

  it("replaces an image it cannot decode with a note", async () => {
    const content = [
      { type: "file" as const, uri: dataUri("image/png", Buffer.from("junk")), mime: "image/png", name: "broken.png" },
    ]
    const result = await withImage((image) => SessionImageNormalize.toolContent(image, content))
    expect(result[0]?.type).toBe("text")
    if (result[0]?.type !== "text") return
    expect(result[0].text).toContain("broken.png")
    expect(result[0].text).toContain("could not be sent")
  })

  it("replaces an image no encoding can fit under the ceiling with a note", async () => {
    const content = [{ type: "file" as const, uri: dataUri("image/png", Buffer.from(TRANSPARENT_PIXEL, "base64")), mime: "image/png" }]
    const result = await withImage(
      (image) => SessionImageNormalize.toolContent(image, content),
      new ConfigAttachments.Image({ max_base64_bytes: 1 }),
    )
    expect(result[0]?.type).toBe("text")
  })

  it("leaves text parts and non-image files alone", async () => {
    const content = [
      { type: "text" as const, text: "hello" },
      { type: "file" as const, uri: dataUri("application/pdf", Buffer.from("%PDF-1.4")), mime: "application/pdf" },
    ]
    const result = await withImage((image) => SessionImageNormalize.toolContent(image, content))
    expect(result).toEqual(content)
  })
})
