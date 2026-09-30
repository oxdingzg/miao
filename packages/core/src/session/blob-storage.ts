export * as SessionBlobStorage from "./blob-storage"

import { Effect } from "effect"
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
