import { Effect } from "effect"
import { Blob } from "../../blob"
import { SessionMessage } from "../message"

/**
 * Resolves `blob://<hash>` attachment references to inline data URIs before the
 * request is built. The model always receives materialized bytes; only storage
 * holds the content-addressed reference. A missing blob is replaced with a text
 * note instead of sending a broken media part, and the displaced text is kept
 * on the user message.
 */
export const materializeBlobFiles = (blob: Blob.Interface, messages: readonly SessionMessage.Message[]) =>
  Effect.gen(function* () {
    return yield* Effect.forEach(messages, (message) => {
      if (message.type !== "user" || message.files === undefined || message.files.length === 0)
        return Effect.succeed(message)
      return Effect.forEach(message.files, (file) =>
        Effect.gen(function* () {
          const hash = Blob.hashOf(file.uri)
          if (hash === undefined) return { file }
          const base64 = yield* blob.getBase64(hash).pipe(Effect.orElseSucceed(() => undefined))
          if (base64 === undefined) return { note: `[attachment unavailable: ${file.name ?? hash}]` }
          return { file: { ...file, uri: `data:${file.mime};base64,${base64}` } }
        }),
      ).pipe(
        Effect.map((resolved) => {
          const files = resolved.flatMap((item) => (item.file ? [item.file] : []))
          const notes = resolved.flatMap((item) => (item.note ? [item.note] : []))
          return SessionMessage.User.make({
            ...message,
            text: notes.length === 0 ? message.text : `${message.text}\n${notes.join("\n")}`,
            files: files.length === 0 ? undefined : files,
          })
        }),
      )
    })
  })
