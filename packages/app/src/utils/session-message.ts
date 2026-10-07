import type { AssistantMessage, Message, UserMessage } from "@miao/schema/view-models"
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageUser,
} from "@/utils/server"
import { contentParts } from "@/pages/session/timeline/content"

const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const emptyModel: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }

export function compareMessages(a: Pick<Message, "id" | "time">, b: Pick<Message, "id" | "time">) {
  const left = messageKey(a)
  const right = messageKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export const messageKey = (message: Pick<Message, "id" | "time">) => message.time.created + message.id

export function normalizeSessionMessages(sessionID: string, source: readonly SessionMessageInfo[]) {
  const messages: Message[] = []
  let agent = ""
  let model = emptyModel
  let parentID: string | undefined

  source.forEach((message) => {
    if (message.type === "agent-switched") {
      agent = message.agent
      return
    }
    if (message.type === "model-switched") {
      model = message.model
      return
    }
    if (message.type === "user") {
      parentID = message.id
      messages.push(userMessage(sessionID, message, agent, model))
      return
    }
    if (message.type === "synthetic" && message.text.trim()) {
      parentID = message.id
      messages.push({
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
      })
      return
    }
    if (message.type === "shell") {
      messages.push(...shellMessages(sessionID, message, agent, model))
      parentID = undefined
      return
    }
    if (message.type === "assistant") {
      agent = message.agent
      model = message.model
      if (!parentID) return
      const parent = messages.findLast((item) => item.id === parentID)
      if (parent?.role === "user") {
        parent.agent = message.agent
        parent.model = {
          providerID: message.model.providerID,
          modelID: message.model.id,
          variant: message.model.variant,
        }
      }
      messages.push(assistantMessage(sessionID, parentID, message))
      return
    }
    // Compaction contributes no message row; its marker is a part on the parent turn.
  })

  return { messages, parts: new Map(Object.entries(contentParts(sessionID, source))) }
}

function shellMessages(
  sessionID: string,
  message: SessionMessageShell,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): [UserMessage, AssistantMessage] {
  return [
    {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent,
      model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
    },
    {
      id: `${message.id}:assistant`,
      sessionID,
      role: "assistant",
      time: message.time,
      parentID: message.id,
      modelID: model.id,
      providerID: model.providerID,
      variant: model.variant,
      mode: agent,
      agent,
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: emptyTokens,
    },
  ]
}

function userMessage(
  sessionID: string,
  message: SessionMessageUser,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: message.time,
    agent,
    model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
  }
}

function assistantMessage(sessionID: string, parentID: string, message: SessionMessageAssistant): AssistantMessage {
  const error = message.error
    ? message.error.type.toLowerCase().includes("abort") || message.error.type.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    error,
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    finish: message.finish,
  }
}
