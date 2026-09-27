export * as SessionPrune from "./prune"

import { Message, type ContentPart, type ToolResultValue } from "@miao/llm"

const CLEARED: ToolResultValue = { type: "text", value: "[older tool output cleared to save context]" }

/** Character budget of the most recent tool output kept verbatim. */
export const PROTECT_CHARS = 40_000

/**
 * Clears tool-result payloads older than the most recent `protectChars` of tool
 * output in a provider request. Only the outgoing request is affected; stored
 * history is untouched. Lossy by design, so callers gate it behind opt-in config.
 */
export const toolResults = (messages: ReadonlyArray<Message>, protectChars = PROTECT_CHARS): Message[] => {
  const parts: Array<{ message: number; part: number; size: number }> = []
  messages.forEach((message, messageIndex) =>
    message.content.forEach((part, partIndex) => {
      if (part.type !== "tool-result") return
      parts.push({ message: messageIndex, part: partIndex, size: JSON.stringify(part.result).length })
    }),
  )

  let budget = protectChars
  const cleared = new Set<string>()
  for (let index = parts.length - 1; index >= 0; index--) {
    const item = parts[index]!
    if (item.size <= budget) {
      budget -= item.size
      continue
    }
    cleared.add(`${item.message}:${item.part}`)
  }
  if (cleared.size === 0) return [...messages]

  const clearedMessages = new Set(Array.from(cleared, (key) => Number(key.split(":")[0])))
  return messages.map((message, messageIndex) => {
    if (!clearedMessages.has(messageIndex)) return message
    const content = message.content.map((part, partIndex): ContentPart =>
      part.type === "tool-result" && cleared.has(`${messageIndex}:${partIndex}`) ? { ...part, result: CLEARED } : part,
    )
    return new Message({ id: message.id, role: message.role, content, metadata: message.metadata, native: message.native })
  })
}
