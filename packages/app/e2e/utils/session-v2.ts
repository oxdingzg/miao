import { OpenCodeEvent, type OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import { SessionMessage } from "@miao/schema/session-message"
import { expect, type Page } from "@playwright/test"
import { Schema } from "effect"
import { base64Encode } from "@miao/core/util/encode"
import { mockOpenCodeServer } from "./mock-server"
import { installSseTransport } from "./sse-transport"
import { expectSessionTitle } from "./waits"

export const directory = "C:/OpenCode/SessionV2"
export const sessionID = "ses_e2e_v2"
export const userID = "msg_1000_v2_user"
export const assistantID = "msg_1001_v2_assistant"
export const title = "V2 timeline"
export const model = { providerID: "opencode", id: "claude-opus-4-6" }
export type Message = typeof SessionMessage.Message.Encoded
export type Content = typeof SessionMessage.AssistantContent.Encoded
export type Assistant = typeof SessionMessage.Assistant.Encoded

const validateMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const validateEvent = Schema.decodeUnknownSync(OpenCodeEvent)

export function user(text = "Inspect the timeline", input: { id?: string; created?: number } = {}) {
  const message = {
    id: input.id ?? userID,
    type: "user" as const,
    text,
    time: { created: input.created ?? 1700000000000 },
  }
  validateMessage(message)
  return message
}

export function assistant(
  content: Content[] = [],
  input: { id?: string; created?: number; completed?: boolean } = {},
): Assistant {
  const message = {
    id: input.id ?? assistantID,
    type: "assistant" as const,
    agent: "build",
    model,
    content,
    cost: 0.01,
    tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: input.created ?? 1700000001000,
      ...(input.completed === false ? {} : { completed: (input.created ?? 1700000001000) + 1000 }),
    },
  }
  validateMessage(message)
  return message
}

export function text(text: string, id = "text_0"): Content {
  return { type: "text", id, text }
}

export function reasoning(text: string, id = "reasoning_0"): Content {
  return { type: "reasoning", id, text, time: { created: 1700000001000 } }
}

export function partID(type: "text" | "reasoning", ordinal = 0, messageID = assistantID) {
  return `${messageID}:${type}:${ordinal}`
}

export function tool(
  id: string,
  name: string,
  status: "running" | "completed",
  input: Record<string, unknown> = {},
  output = "Completed",
  structured: Record<string, unknown> = {},
): Content {
  return {
    type: "tool",
    id,
    name,
    state: {
      status,
      input,
      structured,
      content: [{ type: "text", text: output }],
    },
    time: { created: 1700000001000, ...(status === "completed" ? { completed: 1700000002000 } : {}) },
  }
}

export function event<Type extends OpenCodeEventEncoded["type"]>(
  type: Type,
  data: Extract<OpenCodeEventEncoded, { type: Type }>["data"],
): OpenCodeEventEncoded {
  const value = { id: `evt_v2_${crypto.randomUUID()}`, type, location: { directory }, data }
  return Schema.encodeSync(OpenCodeEvent)(validateEvent(value))
}

export function status(type: "busy" | "idle") {
  return event("session.next.status", { sessionID, timestamp: 1700000003000, status: { type } })
}

export function ended(message = assistant()) {
  return event("session.next.step.ended", {
    sessionID,
    timestamp: message.time.completed ?? 1700000003000,
    assistantMessageID: message.id,
    finish: "stop",
    cost: message.cost ?? 0,
    tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

export async function setup(page: Page, input: { messages?: Message[]; settings?: Record<string, boolean> } = {}) {
  const messages = input.messages ?? [user(), assistant([], { completed: false })]
  messages.forEach((message) => validateMessage(message))
  const transport = await installSseTransport<OpenCodeEventEncoded>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_e2e_v2",
      worktree: directory,
      name: "V2 tests",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: model.providerID,
          name: "OpenCode",
          models: { [model.id]: { id: model.id, name: "Claude Opus 4.6", limit: { context: 200000 } } },
        },
      ],
      connected: [model.providerID],
      default: { [model.providerID]: model.id },
    },
    sessions: [{ id: sessionID, projectID: "proj_e2e_v2", directory, title, time: { created: 1, updated: 1 } }],
    sessionStatus: {
      [sessionID]: {
        type: messages.some((message) => message.type === "assistant" && !message.time.completed) ? "busy" : "idle",
      },
    },
    pageMessages: () => ({ items: messages }),
    message: (_, id) => messages.find((message) => message.id === id),
  })
  await page.addInitScript((settings) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          showReasoningSummaries: false,
          shellToolPartsExpanded: false,
          editToolPartsExpanded: false,
          ...settings,
        },
      }),
    )
  }, input.settings ?? {})
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  return {
    transport,
    async send(value: OpenCodeEventEncoded) {
      validateEvent(value)
      await transport.send(value)
    },
    async waitForPart(id: string) {
      await expect(page.locator(`[data-timeline-part-id="${id}"]`)).toBeVisible()
    },
  }
}
