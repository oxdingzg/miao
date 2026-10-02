export * as Image from "./image"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { FileSystem } from "./filesystem"

const DEFAULT_MAX_WIDTH = 2_000
const DEFAULT_MAX_HEIGHT = 2_000
const DEFAULT_MAX_BASE64_BYTES = 5 * 1024 * 1024
/** The practical budget images are shrunk to, matching Claude Code's `imageMaxRawBytes`. */
const DEFAULT_TARGET_RAW_BYTES = 512_000

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("Image.DecodeError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

/**
 * Two byte budgets, in decoded bytes. Adapters encode to raw bytes, so the
 * comparison happens there; `maxBase64Bytes` is carried along only so the
 * rejection message can report the limit the user actually configured.
 */
export interface Limits {
  readonly autoResize: boolean
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxBase64Bytes: number
  /** Hard ceiling. Beyond this the image is rejected rather than sent. */
  readonly maxRawBytes: number
  /** The budget encoding aims for, well below the ceiling. */
  readonly targetRawBytes: number
}

/** Largest decoded payload whose base64 form still fits `bytes`. */
export const rawBudget = (bytes: number) => 3 * Math.floor(bytes / 4)

/** Encoded length of the same payload when carried as base64. */
export const base64Length = (raw: number) => Math.ceil(raw / 3) * 4

export type Error = ResizerUnavailableError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) => Effect.Effect<FileSystem.Content & { readonly encoding: "base64" }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@miao/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const normalizers = yield* Effect.cached(
      Effect.gen(function* () {
        const bun = yield* Effect.tryPromise({
          try: () => import("./image/bun"),
          catch: () => new ResizerUnavailableError(),
        }).pipe(
          Effect.flatMap((module) => (module.available() ? module.make : Effect.succeed(undefined))),
          Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(undefined)),
        )
        const photon = yield* Effect.tryPromise({
          try: () => import("./image/photon"),
          catch: () => new ResizerUnavailableError(),
        }).pipe(Effect.flatMap((module) => module.make))
        return { bun, photon }
      }),
    )
    const normalize = Effect.fn("Image.normalize")(function* (
      resource: string,
      content: FileSystem.Content & { readonly encoding: "base64" },
    ) {
      const image = Object.assign(
        {},
        ...(yield* config.entries()).flatMap((entry) =>
          entry.type === "document" && entry.info.attachments?.image ? [entry.info.attachments.image] : [],
        ),
      )
      const maxBase64Bytes = image.max_base64_bytes ?? DEFAULT_MAX_BASE64_BYTES
      const maxRawBytes = rawBudget(maxBase64Bytes)
      const limits: Limits = {
        autoResize: image.auto_resize ?? true,
        maxWidth: image.max_width ?? DEFAULT_MAX_WIDTH,
        maxHeight: image.max_height ?? DEFAULT_MAX_HEIGHT,
        maxBase64Bytes,
        maxRawBytes,
        targetRawBytes: Math.min(image.target_raw_bytes ?? DEFAULT_TARGET_RAW_BYTES, maxRawBytes),
      }
      const loaded = yield* normalizers
      if (loaded.bun === undefined) return yield* loaded.photon(resource, content, limits)
      // `Bun.Image` does not read every container photon does (CMYK JPEG and
      // animated WebP are the known gaps), so an undecodable image falls back
      // rather than turning today's working attachments into failures.
      return yield* loaded.bun(resource, content, limits).pipe(
        Effect.catchTag("Image.DecodeError", () => loaded.photon(resource, content, limits)),
      )
    })
    return Service.of({ normalize })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
