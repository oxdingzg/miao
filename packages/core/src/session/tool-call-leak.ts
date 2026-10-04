export * as ToolCallLeak from "./tool-call-leak"

/**
 * Detection for tool calls a model wrote as plain assistant text instead of
 * emitting a structured tool call. The turn then finishes `stop` with no tool
 * part, so the session loop halts mid-task and (once the raw text is in
 * history) the model imitates it on every later turn. See issue #2.
 *
 * Detection is deliberately conservative. It only fires when the assistant text
 * *ends* with a recognizable tool-call block, so prose that mentions these tags
 * mid-text does not trigger it. A message that genuinely ends with example
 * tool-call markup is an accepted false positive: it costs one extra provider
 * round-trip, capped at `MAX_ATTEMPTS` per user prompt.
 *
 * Recovery never parses or executes the leaked text. It nudges the model to
 * re-issue the call through the normal tool-calling path, so permissions and
 * tool resolution are untouched (the approach used by opencode upstream and by
 * Claude Code's malformed-retry).
 */

// Qwen emits `<function=name>` / `<function_name>`; drift variants use
// `<function_name>` or a bare `<function>`. Hermes wraps JSON in `<tool_call>`.
// DeepSeek's V4 Flash leaks DSML framed with fullwidth pipes (`<｜｜DSML｜｜...>`,
// U+FF5C) and sometimes doubles the marker. Claude-style `antml:` namespaced
// markup can also leak through Anthropic-compatible gateways.
const OPENING =
  /<tool_calls?>|<function[=_][\w.-]+>|<parameter[=][\w.-]+>|<[^>]*DSML[^>]*>|<antml:(?:tool_calls?|invoke)\b|<(?:antml:)?invoke\s+name=/i

// A complete block ends in a closing tag, which real leaks carry even when the
// server ate the opening wrapper. A bare opener truncated mid-argument is a
// "length" finish, not a parser miss, so it is intentionally not matched. The
// tail itself may be cut mid-tag (`</parameter>`, `</para`) when the stream
// ended, so a truncated closing-tag prefix at the very end also counts.
const CLOSING_TAIL =
  /<\/(?:antml:)?(?:tool_calls?|function|parameter|invoke|tool|par|inv|fun|DSML)[a-z_]*>?$|<\/[^>]*DSML[^>]*>$/i

// A model that streamed a full call as text often keeps emitting the closing
// markers after the server ate the opening ones: `</parameter></invoke>` repeats
// with no matching `<invoke`/`<parameter`. A single stray closing tag can appear
// in prose, so require a run of them before treating the tail as a leak.
const STRAY_CLOSING = /<\/(?:invoke|parameter|tool_calls?|function)>/gi
const STRAY_CLOSING_MIN = 3

/** Recovery attempts allowed per real user prompt. */
export const MAX_ATTEMPTS = 2

/** Marker key so a persisted nudge can be recognized from history. */
export const NUDGE_MARKER = "toolCallLeakRecovery"

export const NUDGE =
  "Your previous message wrote a tool call as plain text, so it was NOT executed. " +
  "Do not write tool-call XML, DSML, or JSON inside message text. " +
  "Re-issue the intended call now through the tool-calling mechanism with valid syntax."

/** Whether the assistant text ends with a leaked tool-call block. */
export function detect(text: string): boolean {
  const trimmed = text.trimEnd()
  const stray = trimmed.match(STRAY_CLOSING)?.length ?? 0
  // A tail that begins a closing tool-call tag (or a truncated prefix of one)
  // only counts when its openers are also present, or when it is the end of a
  // long closer run the server left behind — so prose stays prose.
  if (CLOSING_TAIL.test(trimmed.slice(-40)) && (OPENING.test(trimmed) || stray >= STRAY_CLOSING_MIN)) return true
  // An unclosed wrapper still leaks a whole call after a complete `<invoke>`:
  // the opening `</invoke>` is present but the outer `</tool_calls>` was eaten.
  const invokeOpen = trimmed.lastIndexOf("<invoke")
  return invokeOpen !== -1 && trimmed.includes("</invoke>", invokeOpen)
}

/** Whether a synthetic message is a leak-recovery nudge this module emitted. */
export function isNudge(message: {
  readonly type: string
  readonly metadata?: Record<string, unknown>
}): boolean {
  return (
    message.type === "synthetic" &&
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    message.metadata[NUDGE_MARKER] === true
  )
}

/**
 * Recovery attempts since the last real user prompt, derived from history so the
 * cap survives restarts. Walks backward: each trailing nudge synthetic message
 * counts as one attempt. Any other message stops the walk, resetting the budget
 * at a real user prompt.
 */
export function countAttempts(
  messages: ReadonlyArray<{ readonly type: string; readonly metadata?: Record<string, unknown> }>,
): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type === "assistant" || message.type === "agent-switched" || message.type === "model-switched")
      continue
    if (message.type === "synthetic" && isNudge(message)) {
      count++
      continue
    }
    break
  }
  return count
}
