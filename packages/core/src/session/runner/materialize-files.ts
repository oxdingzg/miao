import { Effect } from "effect"
import { isUtf8 } from "buffer"
import { fileURLToPath } from "url"
import { Blob } from "../../blob"
import { FSUtil } from "../../fs-util"
import { SessionMessage } from "../message"
import { SessionEvent } from "../event"
import { Prompt } from "../prompt"

/** Largest attached text inlined into a message, in characters. */
const TEXT_LIMIT = 100_000
/** Most directory entries listed for an attached directory. */
const DIRECTORY_LIMIT = 200

/**
 * Memo of `hash\0mime` to the URI it resolved to, so one pass resolves each
 * distinct blob once. A blob is content-addressed and immutable, so an entry
 * never goes stale; a missing blob is cached as `undefined`.
 */
export type Cache = Map<string, string | undefined>

/**
 * Resolves `blob://<hash>` references to inline data URIs before a message is
 * read. Storage holds the content-addressed reference; the model, the clients
 * and the TUI always see bytes. A reference whose blob is gone is replaced with
 * a text note rather than a broken media part — on a user message the displaced
 * text is appended to `message.text`, on a tool result it becomes a text part of
 * that tool's content, so the information survives either way.
 *
 * Pass a `cache` to share resolutions across calls, as the event stream does;
 * otherwise this pass gets its own.
 */
export const materializeBlobRefs = (
  blob: Blob.Interface,
  messages: readonly SessionMessage.Message[],
  cache: Cache = new Map(),
) => Effect.forEach(messages, (message) => materializeMessage(blob, cache, message))

/**
 * Materializes the references a durable Session event carries. Two families hold
 * them: the tool events carry result content, and the prompt events carry the
 * attachments the client submitted — a prompt is externalized before it is
 * admitted, so a subscriber would otherwise receive `blob://` where it expects
 * media. Every other event is returned unchanged.
 */
export const materializeEvent = (
  blob: Blob.Interface,
  cache: Cache,
  event: SessionEvent.DurableEvent,
): Effect.Effect<SessionEvent.DurableEvent> =>
  Effect.gen(function* () {
    // Each case narrows to exactly one member: spreading a union of payloads
    // first and then narrowing pairs every payload with every event type.
    switch (event.type) {
      case "session.next.command.completed": {
        const prompt = yield* materializePrompt(blob, cache, event.data.prompt)
        return { ...event, data: { ...event.data, prompt } }
      }
      case "session.next.prompted":
      case "session.next.prompt.admitted": {
        const prompt = yield* materializePrompt(blob, cache, event.data.prompt)
        return { ...event, data: { ...event.data, prompt } }
      }
      case "session.next.tool.progress": {
        const content = yield* materializeToolContent(blob, cache, event.data.content)
        return { ...event, data: { ...event.data, content } }
      }
      case "session.next.tool.success": {
        const content = yield* materializeToolContent(blob, cache, event.data.content)
        return { ...event, data: { ...event.data, content } }
      }
      default:
        return event
    }
  })

export const materializePrompt = (blob: Blob.Interface, cache: Cache, prompt: Prompt): Effect.Effect<Prompt> =>
  Effect.gen(function* () {
    if (prompt.files === undefined || prompt.files.length === 0) return prompt
    const resolved = yield* resolveAttachments(blob, cache, prompt.files)
    return Prompt.make({
      ...prompt,
      text: appendNotes(prompt.text, resolved.notes),
      files: resolved.files.length === 0 ? undefined : resolved.files,
    })
  })

/**
 * The callback keeps an explicit return type: without it the three branches
 * widen to a union that `Effect.forEach` cannot infer through, and it falls back
 * to its curried overload.
 */
const materializeMessage = (
  blob: Blob.Interface,
  cache: Cache,
  message: SessionMessage.Message,
): Effect.Effect<SessionMessage.Message> => {
  if (message.type === "user") return materializeUser(blob, cache, message)
  if (message.type === "assistant") return materializeAssistant(blob, cache, message)
  return Effect.succeed(message)
}

/**
 * Derived from `SessionMessage` rather than imported from `@miao/llm`: the two
 * modules declare structurally identical names, and TS treats them as unrelated.
 */
type AssistantContent = SessionMessage.Assistant["content"][number]
type ToolPart = Extract<SessionMessage.AssistantTool["state"], { status: "completed" }>["content"][number]

const materializeUser = (
  blob: Blob.Interface,
  cache: Cache,
  message: SessionMessage.User,
): Effect.Effect<SessionMessage.User> =>
  Effect.gen(function* () {
    if (message.files === undefined || message.files.length === 0) return message
    const resolved = yield* resolveAttachments(blob, cache, message.files)
    return SessionMessage.User.make({
      ...message,
      text: appendNotes(message.text, resolved.notes),
      files: resolved.files.length === 0 ? undefined : resolved.files,
    })
  })

const materializeAssistant = (
  blob: Blob.Interface,
  cache: Cache,
  message: SessionMessage.Assistant,
): Effect.Effect<SessionMessage.Assistant> =>
  Effect.gen(function* () {
    const content = yield* Effect.forEach(
      message.content,
      (item): Effect.Effect<AssistantContent> =>
        item.type !== "tool" ? Effect.succeed(item) : materializeTool(blob, cache, item),
    )
    return SessionMessage.Assistant.make({ ...message, content })
  })

const materializeTool = (
  blob: Blob.Interface,
  cache: Cache,
  tool: SessionMessage.AssistantTool,
): Effect.Effect<SessionMessage.AssistantTool> =>
  Effect.gen(function* () {
    const state = tool.state
    // A pending call has no result yet, so there is nothing to resolve.
    if (state.status === "pending") return tool
    const content = yield* materializeToolContent(blob, cache, state.content)
    if (state.status !== "completed" || state.attachments === undefined || state.attachments.length === 0)
      return { ...tool, state: { ...state, content } }
    const resolved = yield* resolveAttachments(blob, cache, state.attachments)
    return {
      ...tool,
      state: {
        ...state,
        content:
          resolved.notes.length === 0
            ? content
            : [...content, ...resolved.notes.map((text) => ({ type: "text" as const, text }))],
        attachments: resolved.files.length === 0 ? undefined : resolved.files,
      },
    }
  })

const materializeToolContent = (
  blob: Blob.Interface,
  cache: Cache,
  content: readonly ToolPart[],
): Effect.Effect<readonly ToolPart[]> =>
  Effect.forEach(
    content,
    (part): Effect.Effect<ToolPart> =>
      part.type !== "file"
        ? Effect.succeed(part)
        : resolve(blob, cache, part.uri, part.mime).pipe(
            Effect.map(
              (uri): ToolPart =>
                uri !== undefined
                  ? { ...part, uri }
                  : { type: "text", text: `[attachment unavailable: ${part.name ?? Blob.hashOf(part.uri)}]` },
            ),
          ),
  )

/**
 * Resolves attachment references and splits the outcome: `files` are the ones
 * whose bytes came back, `notes` name the ones whose blob is gone. Callers own
 * where a note belongs — user or prompt text, or a part of a tool result.
 */
const resolveAttachments = (
  blob: Blob.Interface,
  cache: Cache,
  files: readonly Attachment[],
): Effect.Effect<{ readonly files: readonly Attachment[]; readonly notes: readonly string[] }> =>
  Effect.forEach(
    files,
    (file): Effect.Effect<AttachmentResolution> =>
      resolve(blob, cache, file.uri, file.mime).pipe(
        Effect.map(
          (uri): AttachmentResolution =>
            uri !== undefined
              ? { file: { ...file, uri } }
              : { note: `[attachment unavailable: ${file.name ?? Blob.hashOf(file.uri)}]` },
        ),
      ),
  ).pipe(
    Effect.map((resolved) => ({
      files: resolved.flatMap((item) => (item.file ? [item.file] : [])),
      notes: resolved.flatMap((item) => (item.note ? [item.note] : [])),
    })),
  )

type AttachmentResolution = { readonly file?: Attachment; readonly note?: string }

/** The data URI for a stored reference, or undefined when the blob is missing. */
const resolve = (blob: Blob.Interface, cache: Cache, uri: string, mime: string) =>
  Effect.gen(function* () {
    const hash = Blob.hashOf(uri)
    if (hash === undefined) return uri
    // The declared mime is what the caller asked for, so it is part of the key.
    const key = `${hash}\u0000${mime}`
    if (cache.has(key)) return cache.get(key)
    const base64 = yield* blob.getBase64(hash).pipe(Effect.orElseSucceed(() => undefined))
    const resolved = base64 === undefined ? undefined : `data:${mime};base64,${base64}`
    cache.set(key, resolved)
    return resolved
  })

/** Appends the notes for displaced attachments to the text they belong to. */
const appendNotes = (text: string, notes: readonly string[]) =>
  notes.length === 0 ? text : `${text}\n${notes.join("\n")}`

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
