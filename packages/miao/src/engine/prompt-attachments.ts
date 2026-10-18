import { FileAttachment, Source } from "@miao/schema/prompt"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Schema } from "effect"
import { EngineError } from "./client"

const metadata = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Source),
})
const attachment = Schema.Struct({
  mime: Schema.String,
  data: Schema.String,
  metadata: Schema.optionalKey(metadata),
})
export type NativeAttachment = Schema.Schema.Type<typeof attachment>

/** Inline bytes and presentation metadata form one durable admission identity. */
export function encodeAttachments(files: readonly PromptInput.FileAttachment[] = []): NativeAttachment[] {
  if (files.length > 8) throw new EngineError("engine_prompt_unsupported", "native prompts accept at most 8 images")
  return files.map((file) => {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.uri)
    if (!match || !match[1] || !match[2] || match[2].length > 8 * 1024 * 1024)
      throw new EngineError("engine_prompt_unsupported", "native image inputs require bounded inline base64 data")
    if (Buffer.from(match[2], "base64").toString("base64") !== match[2])
      throw new EngineError("engine_prompt_unsupported", "native image input contains invalid base64")
    const details = {
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.description === undefined ? {} : { description: file.description }),
      ...(file.path === undefined ? {} : { path: file.path }),
      ...(file.source === undefined ? {} : { source: file.source }),
    }
    return {
      mime: match[1],
      data: match[2],
      // Even empty metadata distinguishes this product admission from older
      // engines that cannot project attachments back into product history.
      metadata: details,
    }
  })
}

/** Reconstruct files from native durable events, including copied/forked parts. */
export function decodeAttachments(value: unknown) {
  return Schema.decodeUnknownSync(Schema.Array(attachment))(value).map((file) =>
    Schema.decodeUnknownSync(FileAttachment)({
      ...file.metadata,
      mime: file.mime,
      uri: `data:${file.mime};base64,${file.data}`,
    }),
  )
}
