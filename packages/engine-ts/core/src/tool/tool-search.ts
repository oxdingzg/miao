export * as ToolSearch from "./tool-search"

import { type ToolDefinition } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool } from "./tool"

/** The stable name tools are deferred behind when disclosure is enabled. */
export const TOOL_SEARCH_TOOL = "tool_search"

/** Deferred matches returned per search; the index view lists everything. */
const MAX_MATCHES = 5

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Words to match against tool names and descriptions. Leave empty to list the deferred catalog's names and summaries.",
  }),
})

const Output = Schema.Struct({
  text: Schema.String,
})

const firstSentence = (description: string) => {
  const sentence = description.split(/(?<=[.!?])\s/)[0] ?? description
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence
}

const fullSchema = (definition: ToolDefinition) =>
  JSON.stringify(
    { name: definition.name, description: definition.description, input_schema: definition.inputSchema },
    null,
    2,
  )

/**
 * The disclosure side of deferred tool loading: instead of advertising every
 * remote tool's full schema, one stable `tool_search` tool carries the catalog.
 * A search returns the complete schemas of its matches, and the model calls the
 * deferred tool by name on its next step — the registry settles it from the
 * full registration set whether or not it was advertised.
 */
export const make = (input: { readonly deferred: ReadonlyArray<ToolDefinition> }): AnyTool => {
  const index = input.deferred.map((definition) => `- ${definition.name}: ${firstSentence(definition.description)}`)
  const search = (query: string): { text: string } => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) {
      return {
        text: [
          `${input.deferred.length} deferred tools:`,
          ...index,
          "",
          "Search with a query to load full schemas.",
        ].join("\n"),
      }
    }
    const matches = input.deferred
      .filter((definition) => `${definition.name} ${definition.description}`.toLowerCase().includes(needle))
      .slice(0, MAX_MATCHES)
    if (matches.length === 0) return { text: `No deferred tool matches "${query.trim()}".` }
    return {
      text: [
        `${matches.length} match(es). Call them directly by name next:`,
        ...matches.map((definition) => fullSchema(definition)),
      ].join("\n\n"),
    }
  }
  return Tool.make({
    description: [
      `Search tools that are not loaded right now (${input.deferred.length} available).`,
      "An empty query lists their names and summaries; a query returns the full parameter schemas of the matches, so the next step can call them directly by name. Use this before assuming a capability is missing.",
    ].join("\n"),
    input: Parameters,
    output: Output,
    execute: ({ query }) => Effect.succeed(search(query)),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
}
