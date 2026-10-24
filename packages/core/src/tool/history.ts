export * as HistoryTool from "./history"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Token } from "../util/token"
import { RecallTool, type Entry } from "./recall"
import { Tool, type AnyTool } from "./tool"

export const name = "history"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const PAGE_TOKENS = 16_000

export const Input = Schema.Struct({
  from: Schema.Number.pipe(Schema.optional).annotate({
    description:
      "Position (#seq) of the first message to return. Defaults to the start of the session. Pass the `next` value of the previous page to keep reading.",
  }),
  limit: Schema.Number.pipe(Schema.optional).annotate({
    description: `Maximum messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). A page also stops at a token budget.`,
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      type: Schema.String,
      text: Schema.String,
    }),
  ),
  next: Schema.optional(Schema.Number),
})
export type Output = typeof Output.Type

const DESCRIPTION = [
  "Read this session's earlier messages in full, including messages that context compaction removed from the model-visible window.",
  "Pages are position-addressed: take a `#seq` from the recall tool or the `next` value of a previous page. Output is bounded per page; keep reading with `next` when more remains.",
].join(" ")

/**
 * One bounded page of full message text, oldest first. The page stops at
 * `limit` or the token budget, whichever comes first, and reports the position
 * to resume from; a lone message larger than the whole page is clipped so one
 * oversized tool output cannot own every page.
 */
export const page = (entries: ReadonlyArray<Entry>, input: Input): Output => {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const selected: { seq: number; type: string; text: string }[] = []
  let used = 0
  let next: number | undefined
  for (const entry of entries) {
    if (entry.seq < (input.from ?? 1)) continue
    if (selected.length >= limit) {
      next = entry.seq
      break
    }
    const text = RecallTool.messageText(entry.message)
    if (text.length === 0) continue
    const cost = Token.estimate(text)
    if (selected.length > 0 && used + cost > PAGE_TOKENS) {
      next = entry.seq
      break
    }
    used += cost
    selected.push({
      seq: entry.seq,
      type: entry.message.type,
      text:
        cost > PAGE_TOKENS
          ? Token.truncate(
              text,
              PAGE_TOKENS,
              (total) => `[clipped to one page: ~${PAGE_TOKENS} of ~${total} tokens — search the full message with the recall tool]`,
            ).text
          : text,
    })
  }
  return { messages: selected, next }
}

/** Model-visible projection of one page: positioned blocks plus the continuation hint. */
export const render = (output: Output): ReadonlyArray<Tool.Content> => {
  if (output.messages.length === 0) return [{ type: "text", text: "No message at or after that position." }]
  return [
    {
      type: "text",
      text: [
        ...output.messages.map((message) => `[#${message.seq} ${message.type}]\n${message.text}`),
        ...(output.next === undefined ? [] : [`(more remains — continue with history(from: ${output.next}))`]),
      ].join("\n\n"),
    },
  ]
}

/** Builds the history tool around a runner-provided read of the durable history. */
export const make = (read: () => Effect.Effect<ReadonlyArray<Entry>, ToolFailure>): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => render(output),
    execute: (input) => read().pipe(Effect.map((entries) => page(entries, input))),
  })
