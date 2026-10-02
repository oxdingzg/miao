export * as SessionRunnerProviderHeaders from "./provider-headers"

import type { Message, ToolContent } from "@miao/llm"
import { ProviderV2 } from "../../provider"

/**
 * Per-turn headers that depend on the Session and the outgoing messages.
 *
 * Static provider identity headers (originator, User-Agent, API versions) live
 * on the route built by `SessionRunnerModel`; these are the ones V1 provider
 * plugins computed in `chat.headers` from the Session and the request body.
 */
export const forTurn = (input: {
  readonly providerID: string
  readonly sessionID: string
  readonly parentID?: string
  readonly promptCacheKey: string
  readonly messages: ReadonlyArray<Message>
}): Record<string, string> => ({
  "x-session-affinity": input.sessionID,
  "X-Session-Id": input.sessionID,
  ...(input.parentID ? { "x-parent-session-id": input.parentID } : {}),
  // ChatGPT's Codex backend derives prompt-cache affinity from this header,
  // not from prompt_cache_key; without it each request lands on an arbitrary
  // cache server and only hits whatever older prefix that server holds.
  ...(input.providerID === ProviderV2.ID.openai ? { "session-id": input.promptCacheKey } : {}),
  ...(input.providerID === ProviderV2.ID.githubCopilot ? copilot(input) : {}),
})

// Copilot bills and rate-limits premium requests by initiator: only a turn a
// person typed counts as "user"; tool continuations and subagent turns are
// "agent". Vision requests must be flagged or images are rejected.
const copilot = (input: Parameters<typeof forTurn>[0]) => {
  const last = input.messages.at(-1)
  return {
    "X-Interaction-Id": input.sessionID,
    "x-initiator": input.parentID || last?.role !== "user" ? "agent" : "user",
    ...(input.messages.some(hasImage) ? { "Copilot-Vision-Request": "true" } : {}),
  }
}

const hasImage = (message: Message) =>
  message.content.some((part) => {
    if (part.type === "media") return part.mediaType.startsWith("image/")
    if (part.type !== "tool-result") return false
    const result = part.result
    if (result.type !== "content") return false
    return result.value.some((item: ToolContent) => item.type === "file" && item.mime.startsWith("image/"))
  })
