import type { Message, Part, SessionMessage } from "@opencode-ai/sdk/v2"

/**
 * A V2 durable session event that changes the transcript and therefore needs a
 * re-hydration. Location moves (`session.next.moved`) do not change messages.
 */
export function isLiveSessionV2Event(type: string): boolean {
  return type.startsWith("session.next.") && type !== "session.next.moved"
}

/**
 * Maps the V2 session context transcript (`/api/session/:id/context`) into the
 * V1 `Message` + `Part` shape the TUI already renders. This is the read half of
 * the TUI V2 cutover (`specs/v2/tui-read-cutover.md`); writes stay on V1 for now.
 *
 * Only user and assistant messages appear in the transcript; V2 meta messages
 * (agent-switched, model-switched, synthetic, system, shell, compaction) carry
 * no V1 equivalent and are skipped.
 */
export function sessionContextToMessages(input: {
  sessionID: string
  cwd: string
  root: string
  messages: SessionMessage[]
}): { info: Message; parts: Part[] }[] {
  const result: { info: Message; parts: Part[] }[] = []
  let lastAgent = ""
  let lastModel: { providerID: string; modelID: string; variant?: string } = { providerID: "", modelID: "" }
  let lastUserID = ""
  for (const message of input.messages) {
    if (message.type === "agent-switched") {
      lastAgent = message.agent
      continue
    }
    if (message.type === "model-switched") {
      lastModel = { providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant }
      continue
    }
    if (message.type === "user") {
      lastUserID = message.id
      result.push({
        info: {
          id: message.id,
          sessionID: input.sessionID,
          role: "user",
          time: { created: message.time.created },
          agent: lastAgent,
          model: lastModel,
        },
        parts: userParts(input.sessionID, message),
      })
      continue
    }
    if (message.type === "assistant") {
      result.push({
        info: {
          id: message.id,
          sessionID: input.sessionID,
          role: "assistant",
          time: { created: message.time.created, completed: message.time.completed },
          parentID: lastUserID,
          modelID: message.model.id,
          providerID: message.model.providerID,
          mode: message.agent,
          agent: message.agent,
          path: { cwd: input.cwd, root: input.root },
          cost: message.cost ?? 0,
          tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: message.finish,
          error: message.error ? { name: "UnknownError", data: { message: message.error.message } } : undefined,
        },
        parts: message.content.map((content) => {
          if (content.type === "text") {
            return { id: content.id, sessionID: input.sessionID, messageID: message.id, type: "text", text: content.text }
          }
          if (content.type === "reasoning") {
            return {
              id: content.id,
              sessionID: input.sessionID,
              messageID: message.id,
              type: "reasoning",
              text: content.text,
              time: { start: content.time?.created ?? message.time.created, end: content.time?.completed },
            }
          }
          return toolPart(input.sessionID, message.id, content)
        }),
      })
    }
  }
  return result
}

function userParts(sessionID: string, message: Extract<SessionMessage, { type: "user" }>): Part[] {
  const parts: Part[] = []
  if (message.text) {
    parts.push({ id: `${message.id}-text`, sessionID, messageID: message.id, type: "text", text: message.text })
  }
  for (const [index, file] of (message.files ?? []).entries()) {
    parts.push({
      id: `${message.id}-file-${index}`,
      sessionID,
      messageID: message.id,
      type: "file",
      mime: file.mime,
      filename: file.name,
      url: file.uri,
    })
  }
  return parts
}

function toolPart(
  sessionID: string,
  messageID: string,
  tool: Extract<SessionMessage, { type: "assistant" }>["content"][number] & { type: "tool" },
): Part {
  const start = tool.time.ran ?? tool.time.created
  const end = tool.time.completed ?? start
  const state = tool.state
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state:
      state.status === "pending"
        ? { status: "pending", input: {}, raw: String(state.input) }
        : state.status === "running"
          ? { status: "running", input: state.input, time: { start } }
          : state.status === "completed"
            ? {
                status: "completed",
                input: state.input,
                output: textOf(state.content),
                title: tool.name,
                metadata: {},
                time: { start, end },
              }
            : { status: "error", input: state.input, error: state.error.message, metadata: {}, time: { start, end } },
  }
}

function textOf(content: Array<{ type: string; text?: string }>) {
  return content.flatMap((item) => (item.type === "text" ? [item.text ?? ""] : [])).join("\n")
}
