export * as Blob from "./blob"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { Identifier } from "./util/identifier"

/**
 * Content-addressed blob store for large payloads (attachments, oversized tool
 * output). Messages and events persist a `hash + mime` reference instead of the
 * bytes. Storage dedup is not token dedup: callers still materialize the bytes
 * before sending them to the model.
 *
 * See `specs/storage/session-storage-hardening.md` (Workstream D).
 */

export const DIRECTORY = "blobs"

/** URI scheme for a stored blob reference, e.g. `blob://<sha256>`. */
export const SCHEME = "blob://"

/** True when a URI references a stored blob. */
export const isRef = (uri: string) => uri.startsWith(SCHEME)

/** The content hash of a `blob://` reference, or undefined for any other URI. */
export const hashOf = (uri: string) => (uri.startsWith(SCHEME) ? uri.slice(SCHEME.length) : undefined)

/** Builds the canonical reference URI for a content hash. */
export const refUri = (hash: string) => `${SCHEME}${hash}`

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("Blob.StorageError", {
  operation: Schema.Literals(["write", "read", "remove"]),
  hash: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof globalThis.Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} blob ${this.hash}${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

/** A stored blob reference. `hash` is the SHA-256 of the bytes. */
export class Ref extends Schema.Class<Ref>("Blob.Ref")({
  hash: Schema.String,
  mime: Schema.String.pipe(Schema.optional),
  bytes: Schema.Number,
}) {}

export interface Interface {
  readonly put: (input: { readonly bytes: Uint8Array; readonly mime?: string }) => Effect.Effect<Ref, Error>
  readonly get: (hash: string) => Effect.Effect<Uint8Array | undefined, Error>
  /** Base64 of the stored bytes, or undefined when the blob is missing. */
  readonly getBase64: (hash: string) => Effect.Effect<string | undefined, Error>
  readonly has: (hash: string) => Effect.Effect<boolean>
  readonly remove: (hash: string) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Blob") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    const pathFor = (hash: string) => path.join(directory, hash)

    const has: Interface["has"] = (hash) => fs.existsSafe(pathFor(hash))

    // Blobs are content-addressed and immutable, so their base64 is stable. The
    // model reads the whole transcript every turn; without this, every historical
    // attachment is re-read from disk and re-encoded every turn. Bounded by the
    // encoded length so a long-lived process cannot retain unbounded media.
    const BASE64_CACHE_MAX_BYTES = 64 * 1024 * 1024
    const base64Cache = new Map<string, string>()
    let base64CacheBytes = 0

    const getBase64: Interface["getBase64"] = (hash) =>
      Effect.gen(function* () {
        const cached = base64Cache.get(hash)
        if (cached !== undefined) {
          base64Cache.delete(hash)
          base64Cache.set(hash, cached)
          return cached
        }
        const bytes = yield* get(hash)
        if (bytes === undefined) return undefined
        const base64 = Buffer.from(bytes).toString("base64")
        if (base64.length > BASE64_CACHE_MAX_BYTES) return base64
        base64Cache.set(hash, base64)
        base64CacheBytes += base64.length
        while (base64CacheBytes > BASE64_CACHE_MAX_BYTES) {
          const oldest = base64Cache.keys().next().value
          if (oldest === undefined) break
          base64CacheBytes -= base64Cache.get(oldest)!.length
          base64Cache.delete(oldest)
        }
        return base64
      })

    const get: Interface["get"] = Effect.fn("Blob.get")(function* (hash) {
      const target = pathFor(hash)
      if (!(yield* fs.existsSafe(target))) return undefined
      return yield* fs
        .readFile(target)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", hash, cause })))
    })

    const put: Interface["put"] = Effect.fn("Blob.put")(function* (input) {
      const hash = Hash.sha256(input.bytes)
      const ref = new Ref({
        hash,
        bytes: input.bytes.length,
        ...(input.mime === undefined ? {} : { mime: input.mime }),
      })
      if (yield* fs.existsSafe(pathFor(hash))) return ref
      const temp = path.join(directory, `.${hash}.${Identifier.ascending()}.tmp`)
      yield* fs.ensureDir(directory).pipe(
        Effect.mapError((cause) => new StorageError({ operation: "write", hash, cause })),
      )
      // Write to a temporary sibling and rename so a crash never leaves a
      // partially written blob under its content address.
      yield* fs
        .writeFile(temp, input.bytes)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", hash, cause })))
      yield* fs
        .rename(temp, pathFor(hash))
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", hash, cause })))
      return ref
    })

    const remove: Interface["remove"] = Effect.fn("Blob.remove")(function* (hash) {
      const target = pathFor(hash)
      if (!(yield* fs.existsSafe(target))) return false
      yield* fs.remove(target).pipe(Effect.mapError((cause) => new StorageError({ operation: "remove", hash, cause })))
      const cached = base64Cache.get(hash)
      if (cached !== undefined) {
        base64CacheBytes -= cached.length
        base64Cache.delete(hash)
      }
      return true
    })

    return Service.of({ put, get, getBase64, has, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
