// Apply an `LLMRequest.cache` policy by injecting `CacheHint`s onto the parts
// the policy designates. Runs once at compile time, before the per-protocol
// body builder, so the existing inline-hint lowering path handles the rest.
//
// The default `"auto"` shape spends the four available breakpoints on the parts
// that pay off at different rates: the last tool definition (the whole tool
// prefix), the first and last distinct system parts (base agent, project, and
// session prefixes), and the newest message boundary. Advancing that last
// boundary after every tool result keeps the recent conversation prefix
// reusable for the rest of a long turn, whereas a breakpoint pinned to the
// latest user message is written once and then never read again until the next
// user message.
//
// Manual `cache: CacheHint` placements on individual parts are preserved and
// count against the four-breakpoint budget, so auto only fills what is left.
// Anthropic and Bedrock reject more than four cache markers per request, and
// the budget is what keeps a request with manual placements from exceeding it.
import { CacheHint, type CachePolicy, type CachePolicyObject } from "./schema/options"
import { LLMRequest, Message, ToolDefinition, type ContentPart } from "./schema/messages"

const AUTO: CachePolicyObject = {
  tools: true,
  system: true,
  messages: { tail: 1 },
}

const NONE: CachePolicyObject = {}
const BREAKPOINT_CAP = 4

// Resolution rules:
//   - undefined   → "auto" — caching is on by default. The math favors it:
//                   Anthropic 5m-cache write is 1.25x base, read is 0.1x,
//                   so a single reuse within 5 minutes already wins.
//   - "auto"      → tools + system + latest user msg.
//   - "none"      → no auto placement; manual `CacheHint`s still flow.
//   - object form → exactly what the caller asked for.
const resolve = (policy: CachePolicy | undefined): CachePolicyObject => {
  if (policy === undefined || policy === "auto") return AUTO
  if (policy === "none") return NONE
  return policy
}

// Protocols whose wire format carries inline cache markers. Keyed by protocol
// id, not route name: the Vertex route for Claude speaks the same Messages wire
// format and declares the same protocol, so keying on the route name silently
// disabled caching there. Protocols that ignore inline markers (OpenAI's
// implicit prefix caching, Gemini's implicit + out-of-band CachedContent) skip
// the whole policy pass — emitting hints for them would be harmless but
// pointless.
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])

const makeHint = (ttlSeconds: number | undefined): CacheHint =>
  ttlSeconds !== undefined ? new CacheHint({ type: "ephemeral", ttlSeconds }) : new CacheHint({ type: "ephemeral" })

/** Breakpoints still available to auto placement. Manual hints are counted first. */
interface Budget {
  remaining: number
}

const markLastTool = (tools: ReadonlyArray<ToolDefinition>, hint: CacheHint, budget: Budget): ReadonlyArray<ToolDefinition> => {
  if (tools.length === 0) return tools
  const last = tools.length - 1
  if (tools[last]!.cache || budget.remaining === 0) return tools
  budget.remaining -= 1
  return tools.map((tool, i) => (i === last ? new ToolDefinition({ ...tool, cache: hint }) : tool))
}

// The first system part is the model family persona and the last one is the
// most specific project or session text; both are stable across a session and
// worth a breakpoint of their own. A single part is both boundaries, and gets
// one marker.
const markSystemBoundaries = (
  system: LLMRequest["system"],
  hint: CacheHint,
  budget: Budget,
): LLMRequest["system"] => {
  if (system.length === 0) return system
  let changed = false
  const next = system.map((part, index) => {
    if ((index !== 0 && index !== system.length - 1) || part.cache || budget.remaining === 0) return part
    budget.remaining -= 1
    changed = true
    return { ...part, cache: hint }
  })
  return changed ? next : system
}

const lastIndexOfRole = (messages: ReadonlyArray<Message>, role: Message["role"]): number =>
  messages.findLastIndex((m) => m.role === role)

// Mark the last text part of `messages[index]`. If no text part exists, mark
// the last content part regardless of type — that's the breakpoint position
// in tool-result-only messages too.
const markMessageAt = (
  messages: ReadonlyArray<Message>,
  index: number,
  hint: CacheHint,
  budget: Budget,
): ReadonlyArray<Message> => {
  if (index < 0 || index >= messages.length) return messages
  const target = messages[index]!
  if (target.content.length === 0) return messages
  const lastTextIndex = target.content.findLastIndex((part) => part.type === "text")
  const markAt = lastTextIndex >= 0 ? lastTextIndex : target.content.length - 1
  const existing = target.content[markAt]!
  if (("cache" in existing && existing.cache) || budget.remaining === 0) return messages
  budget.remaining -= 1
  const nextContent = target.content.map((part, i) => (i === markAt ? ({ ...part, cache: hint } as ContentPart) : part))
  const next = new Message({ ...target, content: nextContent })
  // Single pass over `messages`, substituting the one updated entry. Long
  // conversations call this on every request, so avoid `.map()` here — its
  // closure dispatch and identity copies show up in profiling.
  const result = messages.slice()
  result[index] = next
  return result
}

const markMessages = (
  messages: ReadonlyArray<Message>,
  strategy: NonNullable<CachePolicyObject["messages"]>,
  hint: CacheHint,
  budget: Budget,
): ReadonlyArray<Message> => {
  if (messages.length === 0) return messages
  if (strategy === "latest-user-message") return markMessageAt(messages, lastIndexOfRole(messages, "user"), hint, budget)
  if (strategy === "latest-assistant")
    return markMessageAt(messages, lastIndexOfRole(messages, "assistant"), hint, budget)
  // Newest boundary first: a breakpoint at a later position covers every
  // earlier prefix too, so when the budget runs out the newest boundary is the
  // one worth spending it on.
  let next = messages
  let marked = 0
  for (let i = messages.length - 1; i >= 0 && marked < strategy.tail; i--) {
    const after = markMessageAt(next, i, hint, budget)
    if (after !== next) marked += 1
    next = after
  }
  return next
}

const countHints = (request: LLMRequest): number =>
  request.tools.reduce((count, tool) => count + (tool.cache === undefined ? 0 : 1), 0) +
  request.system.reduce((count, part) => count + (part.cache === undefined ? 0 : 1), 0) +
  request.messages.reduce(
    (count, message) =>
      count +
      message.content.reduce(
        (contentCount, part) => contentCount + ("cache" in part && part.cache !== undefined ? 1 : 0),
        0,
      ),
    0,
  )

export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!RESPECTS_INLINE_HINTS.has(request.model.route.protocol)) return request
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return request

  const hint = makeHint(policy.ttlSeconds)
  const budget = { remaining: Math.max(0, BREAKPOINT_CAP - countHints(request)) }
  const tools = policy.tools ? markLastTool(request.tools, hint, budget) : request.tools
  const system = policy.system ? markSystemBoundaries(request.system, hint, budget) : request.system
  const messages = policy.messages ? markMessages(request.messages, policy.messages, hint, budget) : request.messages

  if (tools === request.tools && system === request.system && messages === request.messages) return request
  return LLMRequest.update(request, { tools, system, messages })
}
