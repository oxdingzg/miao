export * as SessionImageNormalize from "./image-normalize"

import type { ToolContent } from "@miao/llm"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Effect } from "effect"
import { Image } from "../image"

/**
 * Media types every provider protocol accepts and both adapters can decode.
 * Kept in step with `ReadTool`'s set so an image is treated the same wherever it
 * enters a session.
 */
const MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

/** Splits `data:<mime>;base64,<payload>`; undefined for any other URI. */
const inline = (uri: string) => {
  if (!uri.startsWith("data:")) return undefined
  const comma = uri.indexOf(",")
  if (comma < 0) return undefined
  const header = uri.slice(5, comma).split(";")
  if (!header.includes("base64")) return undefined
  return { mime: header[0] ?? "", base64: uri.slice(comma + 1) }
}

const dataUri = (mime: string, base64: string) => `data:${mime};base64,${base64}`

const shrink = (image: Image.Interface, resource: string, mime: string, base64: string) =>
  image
    .normalize(resource, { uri: resource, name: resource, content: base64, encoding: "base64", mime })
    .pipe(Effect.map((normalized) => ({ mime: normalized.mime, base64: normalized.content })))

/**
 * The replacement media type and URI, or undefined when the image needed no
 * change. Fails only with the adapter's own error, so a caller can decide what
 * an image it cannot shrink means for it.
 */
const shrinkUri = (image: Image.Interface, resource: string, uri: string) =>
  Effect.gen(function* () {
    const source = inline(uri)
    if (source === undefined || !MIMES.has(source.mime)) return undefined
    const shrunk = yield* shrink(image, resource, source.mime, source.base64)
    if (shrunk.mime === source.mime && shrunk.base64 === source.base64) return undefined
    return { mime: shrunk.mime, uri: dataUri(shrunk.mime, shrunk.base64) }
  }).pipe(Effect.tapError((error) => Effect.logDebug("image left unshrunk", { resource, error })))

/**
 * Shrinks inline image attachments on a submitted prompt. This runs at the
 * client boundary — the server's `session.prompt` route, which is the only place
 * a Prompt is admitted and the only one holding the Location services that carry
 * the image limits — so every client benefits without one: TUI pastes, the web
 * app, ACP/IDE, the SDK, and `miao run --file`.
 *
 * Best-effort: an attachment that cannot be re-encoded keeps its original bytes,
 * because rejecting a prompt over one image would be worse than sending it
 * unchanged and letting the provider decide.
 */
export const promptInput = (image: Image.Interface, prompt: PromptInput.Prompt): Effect.Effect<PromptInput.Prompt> =>
  Effect.gen(function* () {
    if (prompt.files === undefined || prompt.files.length === 0) return prompt
    const files = yield* Effect.forEach(prompt.files, (file) =>
      shrinkUri(image, file.name ?? "attachment", file.uri).pipe(
        Effect.orElseSucceed(() => undefined),
        // A submitted attachment carries no media type of its own: the resolver
        // reads it back out of the URI, so only the URI needs rewriting.
        Effect.map((shrunk) => (shrunk === undefined ? file : { ...file, uri: shrunk.uri })),
      ),
    )
    return { ...prompt, files }
  })

/**
 * Normalizes image parts of a tool result at the single point where a settled
 * result becomes durable, which is what bounds built-in, plugin, and MCP tools
 * without each of them carrying its own copy limit.
 *
 * An image that cannot be decoded or cannot be brought under the configured
 * ceiling is replaced with a note: at this boundary the bytes are known to be
 * unusable by the model, and a note keeps the turn alive instead of failing it.
 * A missing adapter is not that case, so those bytes are left alone.
 */
export const toolContent = (
  image: Image.Interface,
  content: ReadonlyArray<ToolContent>,
): Effect.Effect<ReadonlyArray<ToolContent>> =>
  Effect.forEach(content, (part) => {
    if (part.type !== "file") return Effect.succeed(part)
    return shrinkUri(image, part.name ?? "tool image", part.uri).pipe(
      // `mime` has to follow the URI: the media part the model receives is built
      // from the declared media type, not from the URI header.
      Effect.map((shrunk) => (shrunk === undefined ? part : { ...part, ...shrunk })),
      Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(part)),
      Effect.catch((error) =>
        Effect.succeed({
          type: "text" as const,
          text: `[image omitted: ${part.name ?? "tool image"} could not be sent — ${error.message}]`,
        }),
      ),
    )
  })
