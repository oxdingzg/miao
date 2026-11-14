// @ts-ignore Bun's static file import is embedded by `bun build --compile`; some consumers also declare *.wasm.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "../filesystem"
import { base64Length, DecodeError, ResizerUnavailableError, SizeError, type Limits } from "../image"

/** Descending, so a later attempt can never turn out larger than an earlier one. */
const JPEG_QUALITIES = [80, 60, 40, 20]
const RESIZE_STEPS = 12
const RESIZE_FACTOR = 0.75

export const make = Effect.gen(function* () {
  ;(globalThis as typeof globalThis & { __MIAO_PHOTON_WASM_PATH?: string }).__MIAO_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  const loadPhoton = yield* Effect.cached(
    Effect.tryPromise({
      try: () => import("@silvia-odwyer/photon-node"),
      catch: () => new ResizerUnavailableError(),
    }),
  )
  return Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Limits,
  ) {
    const photon = yield* loadPhoton
    const source = Buffer.from(content.content, "base64")
    const decoded = yield* Effect.try({
      try: () => photon.PhotonImage.new_from_byteslice(source),
      catch: () => new DecodeError({ resource }),
    })
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      const reject = () =>
        new SizeError({
          resource,
          width,
          height,
          bytes: base64Length(source.length),
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        })
      if (width <= limits.maxWidth && height <= limits.maxHeight && source.length <= limits.targetRawBytes) return content
      if (!limits.autoResize) {
        if (width <= limits.maxWidth && height <= limits.maxHeight && source.length <= limits.maxRawBytes) return content
        return yield* reject()
      }
      let smallest: { content: string; mime: string; raw: number } | undefined
      for (const size of sizes(width, height, limits)) {
        const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
        try {
          const encoders: Array<readonly [mime: string, encode: () => Uint8Array]> = [
            ["image/png", () => resized.get_bytes()],
            ...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const),
          ]
          for (const [mime, encode] of encoders) {
            const bytes = encode()
            // Encode to base64 before the next candidate can free this buffer.
            const encoded = Buffer.from(bytes).toString("base64")
            if (smallest === undefined || bytes.length < smallest.raw) smallest = { content: encoded, mime, raw: bytes.length }
            if (bytes.length <= limits.targetRawBytes)
              return { ...content, content: encoded, encoding: "base64" as const, mime }
          }
        } finally {
          resized.free()
        }
      }
      if (smallest !== undefined && smallest.raw <= limits.maxRawBytes)
        return { ...content, content: smallest.content, encoding: "base64" as const, mime: smallest.mime }
      return yield* reject()
    } finally {
      decoded.free()
    }
  })
})

const sizes = (width: number, height: number, limits: Limits) => {
  const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
  return Array.from({ length: RESIZE_STEPS }).reduce<Array<{ width: number; height: number }>>((acc) => {
    const previous = acc.at(-1) ?? {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    }
    const next =
      acc.length === 0
        ? previous
        : {
            width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * RESIZE_FACTOR)),
            height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * RESIZE_FACTOR)),
          }
    return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
  }, [])
}
