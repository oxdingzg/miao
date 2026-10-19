export * as SessionTransferSnapshots from "./transfer-snapshots"

import { Effect, Schema } from "effect"
import { RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"

export const Manifest = Schema.Struct({
  id: Snapshot.ID,
  files: Schema.Array(
    Schema.Struct({
      path: RelativePath,
      source_path: RelativePath,
      hash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
      mode: Schema.optional(Schema.Literals(["100644", "100755", "120000"])),
    }),
  ),
})
export type Manifest = typeof Manifest.Type

export class Error extends Schema.TaggedErrorClass<Error>()("SessionTransferSnapshots.Error", {
  reason: Schema.String,
}) {}

/** Export the same selective file states used by SessionRevert: each assistant's
 * declared changed paths, at its original start/end trees. Content lives in the
 * bundle's shared immutable artifact inventory, so repeated file versions dedupe. */
export const capture = Effect.fn("SessionTransferSnapshots.capture")(function* (input: {
  timeline: readonly SessionMessage.Message[]
  artifacts: readonly { hash: string; base64: string }[]
  bytes: number
  maximumBytes: number
}) {
  const references = input.timeline.flatMap((message) =>
    message.type !== "assistant" || !message.snapshot
      ? []
      : [message.snapshot.start, message.snapshot.end]
          .filter((id) => id !== undefined)
          .map((id) => ({ id: Snapshot.ID.make(id), files: message.snapshot?.files ?? [] })),
  )
  const groups = references.reduce((groups, reference) => {
    const files = groups.get(reference.id) ?? new Set<RelativePath>()
    reference.files.forEach((file) => files.add(file))
    groups.set(reference.id, files)
    return groups
  }, new Map<Snapshot.ID, Set<RelativePath>>())
  const state = {
    artifacts: new Map(input.artifacts.map((artifact) => [artifact.hash, artifact.base64])),
    bytes: input.bytes,
  }
  const manifests = yield* Effect.forEach(
    [...groups].sort(([a], [b]) => a.localeCompare(b)),
    ([id, files]) =>
      Effect.gen(function* () {
        if (!/^[a-f0-9]{40,64}$/.test(id)) return yield* new Error({ reason: "Unsupported source snapshot identity" })
        const paths = [...files].sort()
        // Reserve escaped path/metadata overhead before reading another byte. The
        // native relative path is no longer than its project-relative spelling.
        const reserve =
          Buffer.byteLength(
            JSON.stringify(
              paths.map((file) => ({ path: file, source_path: file, hash: "0".repeat(64), mode: "100755" })),
            ),
          ) *
            2 +
          256
        const remaining = Math.floor((input.maximumBytes - state.bytes - reserve) / 4) * 3
        if (remaining < 0) return yield* new Error({ reason: "Snapshot metadata exceeds the transfer byte limit" })
        const rows = paths.length
          ? yield* Effect.gen(function* () {
              const snapshots = yield* Snapshot.Service
              return yield* snapshots.exportFiles({
                files: new Map(paths.map((file) => [file, id])),
                maximumFileBytes: 8 * 1024 * 1024,
                maximumTotalBytes: remaining,
              })
            })
          : []
        const manifest = yield* Schema.decodeUnknownEffect(Manifest)({
          id,
          files: rows.map((row) => {
            const hash = row.bytes === undefined ? null : Hash.sha256(row.bytes)
            if (hash && !state.artifacts.has(hash)) {
              const base64 = Buffer.from(row.bytes ?? []).toString("base64")
              state.artifacts.set(hash, base64)
              state.bytes += base64.length + 128
            }
            return { path: row.path, source_path: row.source_path, hash, mode: row.mode }
          }),
        })
        state.bytes += Buffer.byteLength(JSON.stringify(manifest)) + 1
        if (state.bytes > input.maximumBytes)
          return yield* new Error({ reason: "Snapshot content exceeds the transfer byte limit" })
        return manifest
      }),
  )
  return { snapshots: manifests, artifacts: [...state.artifacts].map(([hash, base64]) => ({ hash, base64 })) }
})
