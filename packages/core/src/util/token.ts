export * as Token from "./token"

import type { encode } from "gpt-tokenizer"

const CHARS_PER_TOKEN = 4

/** Fast character heuristic; used only where a BPE pass is not worth its cost. */
export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

let encoder: typeof encode | undefined

/**
 * BPE token count. Exact for OpenAI-family models (o200k base), a close
 * approximation for other providers, and always better than `estimate` for
 * code and CJK text where the character heuristic under-counts heavily.
 */
export const count = (input: string) => {
  // The o200k tables cost ~27 MB of heap and ~240 ms to load, and only opt-in
  // precise compaction counts tokens, so they load on the first count. `require`
  // keeps `count` synchronous for the measure callbacks that call it.
  encoder ??= (require("gpt-tokenizer") as { encode: typeof encode }).encode
  return encoder(input).length
}

// Providers tokenize attachments by resolution and cap the per-image cost, so
// inline base64 length is the wrong unit for a context budget: a screenshot is a
// few thousand base64 characters per real token. Charging a flat ceiling keeps
// the estimate within an order of magnitude, where measuring the serialized
// value at four characters per token overcounted a 700 KB screenshot by roughly
// 500x and pruned or compacted conversations that comfortably fit.
export const ATTACHMENT_TOKENS = 1_600
const INLINE_BASE64 = /^data:[^,]*;base64,/
const MEDIA_MIME = /^(?:image|audio|video)\//

/**
 * Token estimate for a request-shaped value. Inline base64 payloads, media
 * parts, and media file references are charged per attachment so their byte
 * length never reaches the text measure; every other value recurses until it
 * reaches strings, numbers, or booleans.
 */
export const measureValue = (value: unknown, measure: (text: string) => number = estimate): number => {
  if (typeof value === "string") return INLINE_BASE64.test(value) ? ATTACHMENT_TOKENS : measure(value)
  if (value instanceof Uint8Array) return ATTACHMENT_TOKENS
  if (value === null || typeof value !== "object") return 0
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + measureValue(item, measure), 0)
  const record = value as Record<string, unknown>
  // A media part is an attachment whatever its declared type, including when its
  // payload is a managed or remote URI rather than inline bytes.
  if (record.type === "media") return ATTACHMENT_TOKENS
  if (record.type === "file")
    return typeof record.uri === "string" &&
      (INLINE_BASE64.test(record.uri) || MEDIA_MIME.test(typeof record.mime === "string" ? record.mime : ""))
      ? ATTACHMENT_TOKENS
      : measureValue(record.uri, measure) + measureValue(record.name, measure)
  return Object.values(record).reduce<number>((total, item) => total + measureValue(item, measure), 0)
}
