import { describe, expect, it } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Config } from "@miao/core/config"
import { ConfigAttachments } from "@miao/core/config/attachments"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Image } from "@miao/core/image"
import * as BunAdapter from "@miao/core/image/bun"
import * as PhotonAdapter from "@miao/core/image/photon"

const TRANSPARENT_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const TARGET_RAW_BYTES = 512_000
const MAX_BASE64_BYTES = 5 * 1024 * 1024

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

const normalize = (resource: string, content: string, mime: string, image?: ImageConfig) =>
  Effect.gen(function* () {
    const service = yield* Image.Service
    return yield* service.normalize(resource, { uri: resource, content, encoding: "base64", mime })
  }).pipe(Effect.provide(layer(image)), Effect.exit, Effect.runPromise)

/**
 * A solid source that is genuinely opaque: routing the transparent pixel through
 * JPEG strips the alpha channel, so the re-encoded PNG reports colour type 2 or
 * a palette with no `tRNS`. Fixtures cannot just be a big RGBA PNG, because
 * those are alpha-capable while being fully opaque.
 */
const opaque = async (width: number, height: number, format: "png" | "jpeg") => {
  const decoded = new BunImage(Buffer.from(TRANSPARENT_PIXEL, "base64")).resize(width, height, { fit: "fill" })
  const jpeg = await decoded.jpeg({ quality: 95 }).toBuffer()
  if (format === "jpeg") return Buffer.from(jpeg)
  return Buffer.from(await new BunImage(jpeg).png().toBuffer())
}

const transparent = async (width: number, height: number) =>
  Buffer.from(
    await new BunImage(Buffer.from(TRANSPARENT_PIXEL, "base64")).resize(width, height, { fit: "fill" }).png().toBuffer(),
  )

const metadata = (bytes: Buffer) => new BunImage(bytes).metadata() as Promise<{ width: number; height: number; format: string }>

/** Independent of the adapter under test: reads the PNG container directly. */
const alphaOf = (bytes: Buffer) => {
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return "opaque"
  const colorType = bytes[25]
  if (colorType === 4 || colorType === 6) return "capable"
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1")
    if (type === "tRNS") return "yes"
    if (type === "IDAT" || type === "IEND") break
    offset += 12 + length
  }
  return "no"
}

const decode = (content: string) => Buffer.from(content, "base64")

const succeed = (result: Exit.Exit<{ content: string; mime: string }, unknown>) => {
  expect(Exit.isSuccess(result)).toBe(true)
  if (Exit.isFailure(result)) throw new Error(String(result.cause))
  return result.value
}

describe("Image limits", () => {
  it("converts a base64 budget into the largest decoded payload that fits it", () => {
    expect(Image.rawBudget(MAX_BASE64_BYTES)).toBe(3_932_160)
    expect(Image.base64Length(3_932_160)).toBe(MAX_BASE64_BYTES)
    expect(Image.base64Length(Image.rawBudget(10))).toBeLessThanOrEqual(10)
  })
})

describe("Image normalize", () => {
  it("leaves an image within the target budget byte-identical", async () => {
    const source = await opaque(8, 8, "png")
    const result = succeed(await normalize("tiny.png", source.toString("base64"), "image/png"))
    expect(result.content).toBe(source.toString("base64"))
    expect(result.mime).toBe("image/png")
  })

  it("releases the alpha channel for an opaque png over the byte target", async () => {
    const source = await opaque(2_400, 1_600, "png")
    const result = succeed(await normalize("screen.png", source.toString("base64"), "image/png"))
    // Photon answers the same input with a PNG, so landing on JPEG also proves
    // the Bun adapter is the one that ran.
    expect(result.mime).toBe("image/jpeg")
    expect(decode(result.content).length).toBeLessThanOrEqual(TARGET_RAW_BYTES)
  })

  it("keeps a transparent png as an alpha-carrying png", async () => {
    const source = await transparent(2_400, 1_600)
    const result = succeed(await normalize("overlay.png", source.toString("base64"), "image/png"))
    expect(result.mime).toBe("image/png")
    expect(alphaOf(decode(result.content))).not.toBe("no")
    expect(decode(result.content).length).toBeLessThanOrEqual(TARGET_RAW_BYTES)
  })

  it("clamps dimensions to the configured box", async () => {
    const source = await opaque(3_000, 2_000, "png")
    const result = succeed(await normalize("big.png", source.toString("base64"), "image/png"))
    const measured = await metadata(decode(result.content))
    expect(measured.width).toBeLessThanOrEqual(2_000)
    expect(measured.height).toBeLessThanOrEqual(2_000)
  })

  it("shrinks to target_raw_bytes rather than the api ceiling", async () => {
    const source = await opaque(2_400, 1_600, "jpeg")
    const result = succeed(
      await normalize(
        "photo.jpg",
        source.toString("base64"),
        "image/jpeg",
        new ConfigAttachments.Image({ target_raw_bytes: 40_000 }),
      ),
    )
    expect(decode(result.content).length).toBeLessThanOrEqual(40_000)
  })

  it("caps the target at the max_base64_bytes ceiling", async () => {
    const source = await opaque(2_400, 1_600, "png")
    const result = succeed(
      await normalize(
        "photo.png",
        source.toString("base64"),
        "image/png",
        new ConfigAttachments.Image({ max_base64_bytes: 400_000 }),
      ),
    )
    expect(decode(result.content).length).toBeLessThanOrEqual(Image.rawBudget(400_000))
  })

  it("rejects an oversized image when resizing is disabled", async () => {
    const source = await opaque(16, 1, "png")
    const result = await normalize(
      "wide.png",
      source.toString("base64"),
      "image/png",
      new ConfigAttachments.Image({ auto_resize: false, max_width: 4 }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isSuccess(result)) return
    expect(String(result.cause)).toContain("exceeding configured limits 4x2000")
  })

  it("passes through an image over the target when resizing is disabled but it still fits the ceiling", async () => {
    const source = await opaque(1_200, 900, "png")
    const result = succeed(
      await normalize(
        "keep.png",
        source.toString("base64"),
        "image/png",
        new ConfigAttachments.Image({ auto_resize: false, target_raw_bytes: 1_000 }),
      ),
    )
    expect(result.content).toBe(source.toString("base64"))
  })

  it("rejects an image no encoding can fit under the ceiling", async () => {
    const result = await normalize(
      "pixel.png",
      TRANSPARENT_PIXEL,
      "image/png",
      new ConfigAttachments.Image({ max_base64_bytes: 1 }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isSuccess(result)) return
    expect(String(result.cause)).toContain("/1 bytes")
  })

  it("reports undecodable bytes as a decode error", async () => {
    const result = await normalize("junk.png", Buffer.from("not an image at all").toString("base64"), "image/png")
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isSuccess(result)) return
    expect(String(result.cause)).toContain("Image.DecodeError")
  })
})

describe("Image photon fallback", () => {
  it("normalizes with the shared limits when Bun.Image is unavailable", async () => {
    const adapter = await Effect.runPromise(PhotonAdapter.make)
    const source = await opaque(2_400, 1_600, "png")
    const result = await Effect.runPromise(
      adapter(
        "screen.png",
        { uri: "screen.png", content: source.toString("base64"), encoding: "base64", mime: "image/png" },
        {
          autoResize: true,
          maxWidth: 2_000,
          maxHeight: 2_000,
          maxBase64Bytes: MAX_BASE64_BYTES,
          maxRawBytes: Image.rawBudget(MAX_BASE64_BYTES),
          targetRawBytes: TARGET_RAW_BYTES,
        },
      ),
    )
    expect(decode(result.content).length).toBeLessThanOrEqual(TARGET_RAW_BYTES)
  })
})

describe("Image adapters", () => {
  it("picks the bun adapter when the runtime provides Bun.Image", () => {
    expect(BunAdapter.available()).toBe(typeof BunImage === "function")
  })
})
