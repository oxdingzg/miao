export * as RecallTool from "./recall"

import { ToolFailure, type ToolContent } from "@miao/llm"
import { Effect, Schema } from "effect"
import { SessionMessage } from "../session/message"
import { Tool, type AnyTool } from "./tool"

export const name = "recall"

/** Characters of context kept on each side of a match. */
const EXCERPT_RADIUS = 160
/** Characters of a tool input kept when it is embedded in a message's text. */
const MAX_TOOL_INPUT = 500
const DEFAULT_LIMIT = 10
const MAX_MATCHES = 20

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description: "Text to look up in this session's earlier messages and tool output.",
  }),
  limit: Schema.Number.pipe(Schema.optional).annotate({
    description: `Maximum matches to return (default ${DEFAULT_LIMIT}, max ${MAX_MATCHES}).`,
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      type: Schema.String,
      excerpt: Schema.String,
    }),
  ),
})
export type Output = typeof Output.Type

export type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}
export type Match = Output["matches"][number]

const DESCRIPTION = [
  "Search this session's full durable history for a string, including messages that context compaction removed from the model-visible window.",
  "Matches are returned by position, so a compaction summary that dropped a detail can be recovered from the original message. Use it before re-reading files or re-running work the session already did.",
].join(" ")

const clip = (value: string) => (value.length <= MAX_TOOL_INPUT ? value : `${value.slice(0, MAX_TOOL_INPUT)}…`)

const json = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const contentText = (content: ReadonlyArray<ToolContent>) =>
  content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

const toolText = (part: Extract<SessionMessage.AssistantContent, { type: "tool" }>): string => {
  const state = part.state
  const input = state.status === "pending" ? state.input : clip(json(state.input))
  const output = state.status === "pending" ? "" : contentText(state.content)
  return [`[${part.name}] ${input}`, output].filter((value) => value.length > 0).join("\n")
}

/** The model-visible text of one durable message, for substring search. */
export const messageText = (message: SessionMessage.Message): string => {
  switch (message.type) {
    case "user":
    case "system":
    case "synthetic":
      return message.text
    case "shell":
      return `${message.command}\n${message.output}`
    case "compaction":
      return `${message.summary}\n${message.recent}`
    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text" || part.type === "reasoning") return [part.text]
          if (part.type === "tool") return [toolText(part)]
          return []
        })
        .join("\n")
    default:
      return ""
  }
}

/**
 * Case-insensitive substring search over the durable history, oldest first. The
 * match is reported with a bounded window so the model gets the surrounding
 * context without the whole message.
 */
export const search = (entries: ReadonlyArray<Entry>, query: string, limit: number): ReadonlyArray<Match> => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const matches: Match[] = []
  for (const entry of entries) {
    const text = messageText(entry.message)
    const index = text.toLowerCase().indexOf(needle)
    if (index === -1) continue
    const start = Math.max(0, index - EXCERPT_RADIUS)
    const end = Math.min(text.length, index + needle.length + EXCERPT_RADIUS)
    matches.push({
      seq: entry.seq,
      type: entry.message.type,
      excerpt: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    })
    if (matches.length >= limit) break
  }
  return matches
}

/** Builds the recall tool around a runner-provided read of the durable history. */
export const make = (read: () => Effect.Effect<ReadonlyArray<Entry>, ToolFailure>): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) =>
      output.matches.length === 0
        ? [{ type: "text", text: "No earlier message matches that query." }]
        : [
            {
              type: "text",
              text: output.matches.map((match) => `[#${match.seq} ${match.type}] ${match.excerpt}`).join("\n\n"),
            },
          ],
    execute: (input) =>
      read().pipe(
        Effect.map((entries) => ({
          matches: search(entries, input.query, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_MATCHES)),
        })),
      ),
  })
