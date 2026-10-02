import { Effect } from "effect"
import { isUtf8 } from "buffer"
import { fileURLToPath } from "url"
import { Blob } from "../../blob"
import { FSUtil } from "../../fs-util"
import { SessionMessage } from "../message"

/** Largest attached text inlined into a message, in characters. */
const TEXT_LIMIT = 100_000
/** Most directory entries listed for an attached directory. */
const DIRECTORY_LIMIT = 200

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

/**
 * Inlines text attachments as message text. Provider protocols accept only
 * binary media, and each a different subset (OpenAI, Anthropic: images; Gemini:
 * images, audio, video; Bedrock: images and documents including PDF — see
 * `Protocol.media`), so a source file attached with `@file` (or a text data URI
 * from `miao run --attach`) failed the whole turn with "does not support media
 * type". V1 read such files into the conversation; this does the same. Media
 * (including PDF) is kept as an attachment here; `toLLMMessages` replaces any
 * type the route's protocol rejects with a note. Whether an attachment is text
 * is decided from its content, not its MIME type: extension lookup calls a `.ts`
 * file `video/mp2t`.
 */
export const inlineTextFiles = (fs: FSUtil.Interface, messages: readonly SessionMessage.Message[]) =>
  Effect.forEach(messages, (message) => {
    if (message.type !== "user" || message.files === undefined || message.files.length === 0)
      return Effect.succeed(message)
    return Effect.forEach(
      message.files,
      (file): Effect.Effect<Resolved> => (isMedia(file.mime) ? Effect.succeed({ file }) : readText(fs, file)),
    ).pipe(
      Effect.map((resolved) => {
        const files = resolved.flatMap((item) => (item.file ? [item.file] : []))
        const texts = resolved.flatMap((item) => (item.text ? [item.text] : []))
        return SessionMessage.User.make({
          ...message,
          text: texts.length === 0 ? message.text : [message.text, ...texts].join("\n\n"),
          files: files.length === 0 ? undefined : files,
        })
      }),
    )
  })

type Attachment = NonNullable<SessionMessage.User["files"]>[number]
type Resolved = { readonly file?: Attachment; readonly text?: string }

function isMedia(mime: string) {
  const type = mime.toLowerCase()
  if (type === "application/pdf") return true
  if (type === "video/mp2t") return false
  return type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")
}

const readText = Effect.fnUntraced(function* (fs: FSUtil.Interface, file: Attachment): Effect.fn.Return<Resolved> {
  const name = file.name ?? file.uri
  if (file.uri.startsWith("data:")) {
    const text = decodeDataText(file.uri)
    return text === undefined ? { file } : { text: wrap(name, undefined, text) }
  }
  if (!file.uri.startsWith("file:")) return { file }
  const url = new URL(file.uri)
  const filepath = fileURLToPath(url)
  if (yield* fs.isDir(filepath)) {
    const entries = yield* fs.readDirectoryEntries(filepath).pipe(Effect.orElseSucceed(() => []))
    const listed = entries
      .slice(0, DIRECTORY_LIMIT)
      .map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name))
    const more = entries.length > DIRECTORY_LIMIT ? `\n... ${entries.length - DIRECTORY_LIMIT} more entries` : ""
    return { text: wrap(name, filepath, listed.join("\n") + more) }
  }
  const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
  if (content === undefined) return { text: `[attachment unavailable: ${name}]` }
  if (content.includes("\u0000")) return { file }
  const start = Number(url.searchParams.get("start") ?? "")
  const end = Number(url.searchParams.get("end") ?? "")
  const lines = content.split("\n")
  const selected = start > 0 ? lines.slice(start - 1, end >= start ? end : start).join("\n") : content
  return { text: wrap(name, start > 0 ? `${filepath}#L${start}${end > start ? `-${end}` : ""}` : filepath, selected) }
})

function decodeDataText(uri: string) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri)
  if (!match) return undefined
  const bytes = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8")
  if (bytes.includes(0) || !isUtf8(bytes)) return undefined
  return bytes.toString("utf8")
}

function wrap(name: string, location: string | undefined, text: string) {
  const clipped =
    text.length > TEXT_LIMIT
      ? `${text.slice(0, TEXT_LIMIT)}\n[truncated: ${text.length - TEXT_LIMIT} more characters]`
      : text
  return `<file name="${name}"${location ? ` path="${location}"` : ""}>\n${clipped}\n</file>`
}
