export * as SessionV1Read from "./v1-read"

import { DateTime } from "effect"
import type { SessionV1 } from "../v1/session"
import type { SessionMessage } from "./message"

export interface WithParts {
  readonly info: SessionV1.Info
  readonly parts: ReadonlyArray<SessionV1.Part>
}

const at = (millis: number) => DateTime.makeUnsafe(millis)

const toolState = (state: SessionV1.ToolState): SessionMessage.ToolState => {
  switch (state.status) {
    case "pending":
      return { status: "pending", input: JSON.stringify(state.input) }
    case "running":
      return { status: "running", input: state.input, structured: {}, content: [] }
    case "completed":
      return {
        status: "completed",
        input: state.input,
        structured: {},
        content: [{ type: "text", text: state.output }],
      }
    case "error":
      return {
        status: "error",
        input: state.input,
        structured: {},
        content: [],
        error: { type: "unknown", message: state.error },
      }
  }
}

const assistant = (info: SessionV1.Assistant, parts: ReadonlyArray<SessionV1.Part>): SessionMessage.Message => {
  const content: SessionMessage.AssistantContent[] = []
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", id: part.id, text: part.text })
    else if (part.type === "reasoning") content.push({ type: "reasoning", id: part.id, text: part.text })
    else if (part.type === "tool") {
      const start = "time" in part.state ? part.state.time.start : undefined
      const end = part.state.status === "completed" || part.state.status === "error" ? part.state.time.end : undefined
      content.push({
        type: "tool",
        id: part.callID,
        name: part.tool,
        state: toolState(part.state),
        time: { created: at(start ?? info.time.created), ...(end !== undefined ? { completed: at(end) } : {}) },
      })
    }
  }
  return {
    id: info.id,
    type: "assistant",
    time: {
      created: at(info.time.created),
      ...(info.time.completed !== undefined ? { completed: at(info.time.completed) } : {}),
    },
    agent: info.agent,
    model: { providerID: info.providerID, id: info.modelID, variant: info.variant },
    content,
    ...(info.finish !== undefined ? { finish: info.finish } : {}),
    cost: info.cost,
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cache: info.tokens.cache,
    },
  } as unknown as SessionMessage.Message
}

const user = (info: SessionV1.User, parts: ReadonlyArray<SessionV1.Part>): SessionMessage.Message => {
  const text = parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
  const files = parts
    .filter((part): part is SessionV1.FilePart => part.type === "file")
    .map((part) => ({ uri: part.url, mime: part.mime, name: part.filename }))
  const agents = parts
    .filter((part): part is SessionV1.AgentPart => part.type === "agent")
    .map((part) => ({ name: part.name }))
  return {
    id: info.id,
    type: "user",
    time: { created: at(info.time.created) },
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  } as unknown as SessionMessage.Message
}

/** Maps a legacy V1 session transcript into the V2 projected message shape (read-only). */
export const map = (messages: ReadonlyArray<WithParts>): SessionMessage.Message[] =>
  messages.map(({ info, parts }) => (info.role === "user" ? user(info, parts) : assistant(info, parts)))
