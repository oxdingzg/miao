export * as PromptMaterialization from "./prompt-materialization"

import { fileURLToPath } from "node:url"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Effect } from "effect"
import { EngineError } from "./client"

const MAXIMUM_BYTES = 6 * 1024 * 1024
const failure = (message: string) => new EngineError("engine_prompt_unsupported", message)

/** Snapshot referenced bytes before durable admission so replay needs no source URI. */
export const prepare = Effect.fn("Engine.materializePrompt")(function* (prompt: PromptInput.Prompt) {
  if (!prompt.files?.length) return prompt
  if (prompt.files.length > 8) return yield* Effect.fail(failure("native prompts accept at most 8 images"))
  const files = yield* Effect.forEach(prompt.files, (file) =>
    Effect.gen(function* () {
      if (file.uri.startsWith("data:")) return file
      const bytes = yield* Effect.gen(function* () {
        if (Blob.isRef(file.uri)) {
          const hash = Blob.hashOf(file.uri)
          if (!hash || !/^[a-f0-9]{64}$/.test(hash))
            return yield* Effect.fail(failure("invalid attachment blob reference"))
          const blob = yield* Blob.Service
          const bytes = yield* blob.get(hash, MAXIMUM_BYTES)
          if (!bytes) return yield* Effect.fail(failure("attachment blob is missing"))
          return bytes
        }
        if (file.uri.startsWith("file:")) {
          const filename = yield* Effect.try({
            try: () => fileURLToPath(file.uri),
            catch: () => failure("invalid attachment file URI"),
          })
          const fs = yield* FSUtil.Service
          const info = yield* fs.stat(filename)
          if (info.type !== "File") return yield* Effect.fail(failure("attachment URI must reference a regular file"))
          return yield* FSUtil.readBounded(fs, filename, MAXIMUM_BYTES)
        }
        if (/^https?:\/\//.test(file.uri))
          return yield* Effect.tryPromise({
            try: (signal) => download(file.uri, signal),
            catch: (error) => (error instanceof EngineError ? error : failure("could not download attachment")),
          })
        return yield* Effect.fail(failure("unsupported attachment URI scheme"))
      }).pipe(Effect.mapError((error) => (error instanceof EngineError ? error : failure(error.message))))
      const mime = imageMime(bytes)
      if (!mime)
        return yield* Effect.fail(failure("referenced attachment is not a supported PNG, JPEG, GIF or WebP image"))
      return { ...file, uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` }
    }),
  )
  return { ...prompt, files }
})

function imageMime(bytes: Uint8Array) {
  const header = Buffer.from(bytes.subarray(0, 12))
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
}

async function download(uri: string, signal: AbortSignal) {
  const response = await fetch(uri, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  const reader = response.body?.getReader()
  try {
    if (!response.ok) throw failure(`attachment download returned HTTP ${response.status}`)
    const size = Number(response.headers.get("content-length"))
    if (size > MAXIMUM_BYTES) throw failure("attachment exceeds 6 MiB")
    if (!reader) throw failure("attachment download has no body")
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return Buffer.concat(chunks, total)
      total += chunk.value.byteLength
      if (total > MAXIMUM_BYTES) throw failure("attachment exceeds 6 MiB")
      chunks.push(chunk.value)
    }
  } finally {
    await reader?.cancel().catch(() => undefined)
  }
}
