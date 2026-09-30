export * as SessionPrune from "./prune"

import { Message, type ContentPart, type ToolResultValue } from "@miao/llm"
import { Token } from "../util/token"

const CLEARED: ToolResultValue = { type: "text", value: "[older tool output cleared to save context]" }

/** Token budget of the most recent tool output kept verbatim. */
export const PROTECT_TOKENS = 40_000
/** Clearing less than this frees too little to be worth the detail it drops. */
export const PRUNE_MINIMUM = 20_000
/** Output that carries instructions rather than data stays readable. */
const PROTECTED_TOOLS = ["skill"]
/** User turns whose tool output is never cleared, so the work in flight keeps its data. */
const PROTECTED_TURNS = 2

/**
 * Clears the tool-result payloads an agent no longer needs from a provider
 * request: the two most recent user turns keep their output whatever it costs,
 * and above them the newest `protectTokens` of output stays verbatim. Only the
 * outgoing request is affected; stored history is untouched. Lossy by design, so
 * callers gate it behind opt-in config.
 *
 * The budget is counted in tokens rather than serialized characters, and an
 * attachment is charged its flat ceiling: a read image is a few thousand base64
 * characters per real token, so charging its length would let one screenshot
 * evict every older tool result on its own.
 */
export const toolResults = (messages: ReadonlyArray<Message>, protectTokens = PROTECT_TOKENS): Message[] => {
  const cleared = new Set<string>()
  let savings = 0
  let turns = 0
  let total = 0
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    if (message.role === "user") turns++
    if (turns < PROTECTED_TURNS) continue
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex]
      if (part.type !== "tool-result") continue
      // A provider-executed result is the provider's own record of a server
      // tool, not something this agent produced: Anthropic replays its content
      // back verbatim inside a web_search_tool_result block, so replacing it
      // would send a payload the provider never issued.
      if (part.providerExecuted === true) continue
      if (PROTECTED_TOOLS.includes(part.name)) continue
      const size = Token.measureValue(part.result)
      total += size
      if (total <= protectTokens) continue
      cleared.add(`${messageIndex}:${partIndex}`)
      savings += size
    }
  }
  if (savings <= PRUNE_MINIMUM) return [...messages]

  const clearedMessages = new Set(Array.from(cleared, (key) => Number(key.split(":")[0])))
  return messages.map((message, messageIndex) => {
    if (!clearedMessages.has(messageIndex)) return message
    const content = message.content.map(
      (part, partIndex): ContentPart =>
        part.type === "tool-result" && cleared.has(`${messageIndex}:${partIndex}`)
          ? { ...part, result: CLEARED }
          : part,
    )
    return new Message({
      id: message.id,
      role: message.role,
      content,
      metadata: message.metadata,
      native: message.native,
    })
  })
}
