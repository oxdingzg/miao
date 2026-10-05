export * as SessionBlobStorage from "./blob-storage"

import { Effect } from "effect"
import type { ToolOutput } from "@miao/llm"
import { Blob } from "../blob"
import { Prompt } from "./prompt"

/**
 * Inline attachments above this decoded size are moved into the content-addressed
 * blob store on write; reads materialize them back so clients and the model keep
 * seeing bytes. See `specs/storage/session-storage-hardening.md`.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024

const oversizedBase64 = (uri: string): string | undefined => {
  if (!uri.startsWith("data:")) return undefined
  const comma = uri.indexOf(",")
  if (comma < 0 || !uri.slice(0, comma).includes(";base64")) return undefined
  const base64 = uri.slice(comma + 1)
  return Math.floor((base64.length * 3) / 4) > MAX_INLINE_ATTACHMENT_BYTES ? base64 : undefined
}

/** Replaces oversized inline prompt attachments with `blob://<hash>` references. */
export const externalizePromptAttachments = (blob: Blob.Interface, prompt: Prompt) =>
  Effect.gen(function* () {
    if (prompt.files === undefined || prompt.files.length === 0) return prompt
    const files = yield* Effect.forEach(prompt.files, (file) =>
      Effect.gen(function* () {
        const base64 = oversizedBase64(file.uri)
        if (base64 === undefined) return file
        // Best-effort: a failed blob write keeps the inline payload.
        const ref = yield* blob
          .put({ bytes: Buffer.from(base64, "base64"), mime: file.mime })
          .pipe(Effect.orElseSucceed(() => undefined))
        return ref === undefined ? file : { ...file, uri: Blob.refUri(ref.hash) }
      }),
    )
    return Prompt.make({ ...prompt, files })
  })

/**
 * Replaces oversized inline `content` fields in a tool's raw structured output
 * with `blob://<hash>` references. A tool's raw output often duplicates bytes
 * the model-facing content already carries (an image or PDF-page read is the
 * common case), so leaving it inline doubles the durable payload; the event log
 * grew to hundreds of megabytes of base64 this way. Reads materialize the
 * reference back to bytes. Best-effort: a failed blob write keeps the value.
 */
export const externalizeToolStructured = (
  blob: Blob.Interface,
  structured: Record<string, unknown>,
  /** Set when anything was externalized, so a migration can skip unchanged rows. */
  stats?: { changed: boolean },
): Effect.Effect<Record<string, unknown>> =>
  walkStructured(blob, structured, stats).pipe(Effect.map((value) => value as Record<string, unknown>))

const walkStructured = (blob: Blob.Interface, value: unknown, stats?: { changed: boolean }): Effect.Effect<unknown> => {
  if (Array.isArray(value)) return Effect.forEach(value, (item) => walkStructured(blob, item, stats))
  if (typeof value !== "object" || value === null) return Effect.succeed(value)
  const record = value as Record<string, unknown>
  return Effect.gen(function* () {
    const entries = yield* Effect.forEach(Object.entries(record), ([key, item]) =>
      walkStructured(blob, item, stats).pipe(Effect.map((next) => [key, next] as const)),
    )
    const next = Object.fromEntries(entries)
    const bytes = oversizedStructuredBytes(next)
    if (bytes === undefined) return next
    const ref = yield* blob.put({ bytes, mime: next.mime as string }).pipe(Effect.orElseSucceed(() => undefined))
    if (ref === undefined) return next
    if (stats) stats.changed = true
    return { ...next, content: Blob.refUri(ref.hash), contentRef: true }
  })
}

/** The decoded bytes of an oversized inline `{ content, mime }` field, if any. */
const oversizedStructuredBytes = (record: Record<string, unknown>): Buffer | undefined => {
  if (record.contentRef === true) return undefined
  if (typeof record.content !== "string" || typeof record.mime !== "string") return undefined
  const bytes =
    record.encoding === "base64" ? Buffer.from(record.content, "base64") : Buffer.from(record.content, "utf8")
  return bytes.length > MAX_INLINE_ATTACHMENT_BYTES ? bytes : undefined
}

/** Replaces oversized inline tool-result files with `blob://<hash>` references. */
export const externalizeToolContent = (blob: Blob.Interface, content: ToolOutput["content"]) =>
  Effect.forEach(
    content,
    (part): Effect.Effect<ToolOutput["content"][number]> => {
      if (part.type !== "file") return Effect.succeed(part)
      const base64 = oversizedBase64(part.uri)
      if (base64 === undefined) return Effect.succeed(part)
      // Best-effort: a failed blob write keeps the inline payload.
      return blob
        .put({ bytes: Buffer.from(base64, "base64"), mime: part.mime })
        .pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.map((ref) => (ref === undefined ? part : { ...part, uri: Blob.refUri(ref.hash) })),
        )
    },
  )
