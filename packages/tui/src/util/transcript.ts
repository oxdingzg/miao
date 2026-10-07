import { toolOutputText } from "../context/session-v2"
import type {
  TranscriptAssistantMessage,
  TranscriptMessage,
  TranscriptToolPart,
  TranscriptUserMessage,
} from "@miao/schema/view-models"
import type { Provider } from "@miao/schema/view-models"
import { Locale } from "./locale"
import * as Model from "./model"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

/**
 * A `<system-reminder>` user message is model-facing protocol, not human
 * content. The transcript folds it to one muted line so an injected notice
 * cannot flood the screen with raw protocol text.
 */
export function systemReminderLine(text: string): string | undefined {
  if (!text.startsWith("<system-reminder>")) return undefined
  const end = text.indexOf("</system-reminder>")
  if (end === -1) return undefined
  const first = text.slice("<system-reminder>".length, end).trim().split("\n")[0] ?? ""
  return first.length > 96 ? `${first.slice(0, 95)}…` : first
}

export function formatTranscript(
  session: SessionInfo,
  messages: ReadonlyArray<TranscriptMessage>,
  options: TranscriptOptions,
): string {
  const providers = Model.index(options.providers)
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages.toSorted(
    (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
  )) {
    if (msg.type !== "user" && msg.type !== "assistant") continue
    transcript += formatMessage(msg, options, providers)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(
  msg: TranscriptUserMessage | TranscriptAssistantMessage,
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.type === "user") {
    result += `## User\n\n`
    result += `${msg.text}\n\n`
    for (const file of msg.files ?? []) {
      result += `**File:** ${file.name ?? file.uri}\n`
    }
    if ((msg.files ?? []).length > 0) result += "\n"
    return result
  }

  result += formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers)
  for (const part of msg.content) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: TranscriptAssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  const modelName = Model.name(providers, msg.model.providerID, msg.model.id)

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${modelName}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: TranscriptToolPart | TranscriptAssistantMessage["content"][number], options: TranscriptOptions): string {
  if (part.type === "text") {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.name}**\n`
    if (options.toolDetails && part.state.status !== "pending" && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    const output = toolOutputText(part.state)
    if (options.toolDetails && output) {
      result += `\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error.message) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error.message}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
