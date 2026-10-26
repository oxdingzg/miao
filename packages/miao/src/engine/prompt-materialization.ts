export * as PromptMaterialization from "./prompt-materialization"

import { fileURLToPath } from "node:url"
import { isUtf8 } from "node:buffer"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Effect } from "effect"
import { EngineError } from "./client"

const MAXIMUM_BYTES = 6 * 1024 * 1024
/** Mirrors the runner's listing of an attached directory. */
const DIRECTORY_LIMIT = 200
const failure = (message: string) => new EngineError("engine_prompt_unsupported", message)

/**
 * Snapshot referenced bytes before durable admission so replay needs no source
 * URI. Text references are shaped the way the TypeScript runner shapes them at
 * request time, because the source is not readable from the durable record: a
 * directory mention lists its entries instead of rejecting the prompt, and a
 * `?start`/`?end` mention keeps only the lines it named.
 */
export const prepare = Effect.fn("Engine.materializePrompt")(function* (prompt: PromptInput.Prompt) {
  if (!prompt.files?.length) return prompt
  if (prompt.files.length > 8) return yield* Effect.fail(failure("native prompts accept at most 8 attachments"))
  const files = yield* Effect.forEach(prompt.files, (file) =>
    Effect.gen(function* () {
      if (file.uri.startsWith("data:")) return file
      if (file.uri.startsWith("file:")) {
        const filename = yield* Effect.try({
          try: () => fileURLToPath(file.uri),
          catch: () => failure("invalid attachment file URI"),
        })
        const fs = yield* FSUtil.Service
        if (yield* fs.isDir(filename))
          return inlined(file, listing(yield* fs.readDirectoryEntries(filename).pipe(Effect.orElseSucceed(() => []))))
        // A reference that no longer resolves keeps the turn alive as a note,
        // the same way the runner reports an unusable attachment.
        if (!(yield* fs.existsSafe(filename))) return inlined(file, `[attachment unavailable: ${file.name ?? file.uri}]`)
        const bytes = yield* FSUtil.readBounded(fs, filename, MAXIMUM_BYTES).pipe(
          Effect.mapError((error) => failure(error.message)),
        )
        return yield* materialized(file, bytes)
      }
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
        if (/^https?:\/\//.test(file.uri))
          return yield* Effect.tryPromise({
            try: (signal) => download(file.uri, signal),
            catch: (error) => (error instanceof EngineError ? error : failure("could not download attachment")),
          })
        return yield* Effect.fail(failure("unsupported attachment URI scheme"))
      }).pipe(Effect.mapError((error) => (error instanceof EngineError ? error : failure(error.message))))
      return yield* materialized(file, bytes)
    }),
  )
  return { ...prompt, files }
})

/**
 * Snapshotted bytes stay a media attachment unless they are text, which the
 * engine inlines. Text from a file reference contributes only the lines its URI
 * named, matching the runner's selection.
 */
const materialized = (file: PromptInput.FileAttachment, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const mime = attachmentMime(bytes)
    if (!mime)
      return yield* Effect.fail(failure("referenced attachment is not a supported image, PDF or UTF-8 text file"))
    if (mime !== "text/plain") return { ...file, uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` }
    return inlined(file, selected(file, Buffer.from(bytes).toString("utf8")))
  })

const inlined = (file: PromptInput.FileAttachment, content: string) => ({
  ...file,
  uri: `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`,
})

/** Directory entries as the runner lists them: subdirectories keep their `/`. */
const listing = (entries: readonly FSUtil.DirEntry[]) => {
  const listed = entries
    .slice(0, DIRECTORY_LIMIT)
    .map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name))
  const more = entries.length > DIRECTORY_LIMIT ? `\n... ${entries.length - DIRECTORY_LIMIT} more entries` : ""
  return listed.join("\n") + more
}

const selected = (file: PromptInput.FileAttachment, content: string) => {
  const params = file.uri.startsWith("file:") ? new URL(file.uri).searchParams : undefined
  const start = Number(params?.get("start") ?? "")
  const end = Number(params?.get("end") ?? "")
  if (!(start > 0)) return content
  return content.split("\n").slice(start - 1, end >= start ? end : start).join("\n")
}

function attachmentMime(bytes: Uint8Array) {
  const header = Buffer.from(bytes.subarray(0, 12))
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf"
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  if (!bytes.includes(0) && isUtf8(bytes)) return "text/plain"
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
