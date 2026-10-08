import type { AssistantMessage, Message } from "@miao/schema/view-models"
import type { SessionMessageInfo } from "@/utils/server"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type ContextMessage = {
  id: string
  providerID: string
  modelID: string
  tokens: AssistantMessage["tokens"]
  time: { created: number; completed?: number }
}

type Context = {
  message: ContextMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  total: number
  usage: number | null
}

const tokenTotal = (msg: ContextMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: readonly ContextMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: readonly ContextMessage[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(
    messages.flatMap((message) => (message.role === "assistant" ? [message] : [])),
    providers,
  )
}

export function getSessionContextFromRecords(records: SessionMessageInfo[] = [], providers: Provider[] = []) {
  return build(
    records.flatMap((record) =>
      record.type === "assistant" && record.tokens
        ? [
            {
              id: record.id,
              providerID: record.model.providerID,
              modelID: record.model.id,
              tokens: record.tokens,
              time: record.time,
            },
          ]
        : [],
    ),
    providers,
  )
}
