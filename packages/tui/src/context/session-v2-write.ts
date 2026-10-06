import path from "node:path"
import type { PromptInput, SessionMessage } from "@miao/schema/view-models"
import type { PromptInfo } from "../prompt/history"

type PromptPartLike = {
  readonly type: string
  readonly text?: string
  readonly url?: string
  readonly filename?: string
  readonly source?: Readonly<Record<string, unknown>>
}

/**
 * Maps the TUI's V1-shaped prompt parts into the V2 `PromptInput` payload
 * (`{ text, files }`). Text parts (including synthetic editor context) are
 * joined; file parts become `uri`/`name`, plus `path` when the file was read
 * from an absolute local path. The runner names that path when the provider
 * cannot receive the file (a PDF on OpenAI, for example) so the model can read
 * it with tools. V2 attachments carry no `mime`.
 */
export function promptInputFromParts(parts: ReadonlyArray<PromptPartLike>): PromptInput {
  const text = parts
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .filter((value) => value.length > 0)
    .join("\n\n")
  const files = parts.flatMap((part) => {
    if (part.type !== "file" || part.url === undefined) return []
    const local = part.source?.type === "file" && typeof part.source.path === "string" ? part.source.path : undefined
    return [{ uri: part.url, name: part.filename, ...(local && path.isAbsolute(local) ? { path: local } : {}) }]
  })
  return files.length > 0 ? { text, files } : { text }
}

/** Rebuild the editable prompt from a V2 user message (resend/fork flows). */
export function promptInfoFromUserMessage(
  message: Extract<SessionMessage, { type: "user" }>,
): PromptInfo {
  const parts: PromptInfo["parts"] = [
    ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
    ...(message.files ?? []).map((file) => ({
      type: "file" as const,
      mime: file.mime,
      url: file.uri,
      filename: file.name,
    })),
  ]
  return { input: message.text, parts }
}
