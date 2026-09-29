import type { PromptInput } from "@opencode-ai/sdk/v2"

type PromptPartLike = {
  readonly type: string
  readonly text?: string
  readonly url?: string
  readonly filename?: string
}

/**
 * Maps the TUI's V1-shaped prompt parts into the V2 `PromptInput` payload
 * (`{ text, files }`). Text parts (including synthetic editor context) are
 * joined; file parts become `uri`/`name`. V2 attachments carry no `mime`.
 */
export function promptInputFromParts(parts: ReadonlyArray<PromptPartLike>): PromptInput {
  const text = parts
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .filter((value) => value.length > 0)
    .join("\n\n")
  const files = parts.flatMap((part) =>
    part.type === "file" && part.url !== undefined ? [{ uri: part.url, name: part.filename }] : [],
  )
  return files.length > 0 ? { text, files } : { text }
}
