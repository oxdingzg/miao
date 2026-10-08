import { base64Encode } from "@miao/core/util/encode"
import { OpenCodeEvent, type OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import { Event } from "@miao/schema/event"
import { SessionMessage } from "@miao/schema/session-message"
import { SessionStatusEvent } from "@miao/schema/session-status-event"
import { SessionV1 } from "@miao/schema/session-v1"
import type {
  AssistantMessage,
  Message,
  Part,
  Session,
  SessionStatus,
  ToolPart,
  ToolState,
  UserMessage,
} from "@miao/schema/view-models"
import { expect, type Page } from "@playwright/test"
import { Schema } from "effect"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { installSseTransport } from "../../utils/sse-transport"
import { expectSessionTitle } from "../../utils/waits"

export const directory = "C:/OpenCode/TimelineStability"
export const projectID = "proj_timeline_stability"
export const sessionID = "ses_timeline_stability"
export const userID = "msg_1000_timeline_user"
export const assistantID = "msg_1001_timeline_assistant"
export const title = "Timeline visual stability"
export const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

type TimelinePayload = Extract<
  OpenCodeEventEncoded,
  {
    type:
      | "session.next.status"
      | "session.next.step.ended"
      | "session.next.step.failed"
      | "session.next.text.started"
      | "session.next.text.delta"
      | "session.next.text.ended"
      | "session.next.reasoning.started"
      | "session.next.reasoning.delta"
      | "session.next.reasoning.ended"
      | "session.next.tool.input.started"
      | "session.next.tool.input.delta"
      | "session.next.tool.input.ended"
      | "session.next.tool.called"
      | "session.next.tool.progress"
      | "session.next.tool.success"
      | "session.next.tool.failed"
  }
>

// Removal events have no V2 producer; the app keeps the legacy bridge alive
// for pre-V2 servers, and reducer-hardening scenarios exercise it explicitly.
// Settled-tool re-delivery goes through the same bridge.
type LegacyPayloadType = "message.removed" | "message.part.removed" | "message.part.updated"
type LegacyEvent = {
  directory: string
  payload: {
    id: string
    type: LegacyPayloadType
    properties: { sessionID: string; messageID: string; partID?: string }
  }
}

export type TimelineEvent = TimelinePayload | LegacyEvent
export type EventPayload = TimelineEvent
export type ToolStatus = ToolState["status"]
export type TimelineMessage = { info: UserMessage; parts: Part[] } | { info: AssistantMessage; parts: Part[] }

type UserPart = Extract<Part, { type: "text" | "file" | "agent" | "subtask" }>
type AssistantPart = Exclude<Part, { type: "agent" | "subtask" }>
type OwnedPart<Owner extends Message["role"]> = Owner extends "user" ? UserPart : AssistantPart
export type PartSeed<Owner extends Message["role"]> =
  OwnedPart<Owner> extends infer Candidate
    ? Candidate extends Part
      ? Omit<Candidate, "sessionID" | "messageID">
      : never
    : never

type ToolOptions<State extends ToolStatus> = State extends "pending"
  ? { output?: never; title?: never; metadata?: never; error?: never }
  : State extends "running"
    ? { title?: string; metadata?: Record<string, unknown>; output?: never; error?: never }
    : State extends "error"
      ? { error?: string; metadata?: Record<string, unknown>; output?: never; title?: never }
      : { output?: string; title?: string; metadata?: Record<string, unknown>; error?: never }

const decodeOptions = { errors: "all", onExcessProperty: "error" } as const
const decodeMessage = Schema.decodeUnknownSync(SessionV1.WithParts)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)
const decodeStatus = Schema.decodeUnknownSync(SessionStatusEvent.Info)
const decodeV2Event = Schema.decodeUnknownSync(OpenCodeEvent)
const encodeV2Event = Schema.encodeSync(OpenCodeEvent)
const decodeV2Record = Schema.decodeUnknownSync(SessionMessage.Message)
const legacyEventSchema = Schema.Union([
  eventSchema("message.removed", Schema.Struct({ sessionID: Schema.String, messageID: Schema.String })),
  eventSchema(
    "message.part.removed",
    Schema.Struct({ sessionID: Schema.String, messageID: Schema.String, partID: Schema.String }),
  ),
  eventSchema(
    "message.part.updated",
    Schema.Struct({ sessionID: Schema.String, messageID: Schema.String, part: SessionV1.Part }),
  ),
])
const decodeLegacyEvent = Schema.decodeUnknownSync(legacyEventSchema)

let eventSequence = 0
// Live producer state: the fixture derives the next V2 event batch from what the
// records already show, mirroring the real server's tool state machine.
const seededToolStatus = new Map<string, ToolStatus>()
const liveToolStatus = new Map<string, ToolStatus>()
const streamedParts = new Set<string>()
let timestampSequence = 0

export async function setupTimeline(
  page: Page,
  input: {
    messages?: TimelineMessage[]
    settings?: Record<string, boolean>
    sessions?: Session[]
    cpuRate?: number
    viewport?: { width: number; height: number }
    eventRetry?: number
    reducedMotion?: boolean
    locale?: string
    deviceScaleFactor?: number
    seedHistory?: boolean
  } = {},
) {
  const sessions = input.sessions ?? [session()]
  const messages = validateTimelineMessages([
    ...(input.seedHistory ? historyMessages(18) : []),
    ...(input.messages ?? [userMessage(), assistantMessage()]),
  ])
  const records = messages.map(toRecord)
  records.forEach((record) => decodeV2Record(record, decodeOptions))
  resetProducerState(messages)
  const active = messages.findLast((message) => message.info.role === "assistant")
  const initialStatus = decodeStatus(
    active?.info.role === "assistant" && active.info.time.completed === undefined ? { type: "busy" } : { type: "idle" },
    decodeOptions,
  )
  const transport = await installSseTransport<TimelineEvent>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: input.eventRetry ?? 20,
  })
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    sessionStatus: { [sessionID]: initialStatus },
    pageMessages: () => ({
      items: records,
    }),
  })
  await page.addInitScript((settings) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: false,
          shellToolPartsExpanded: false,
          showReasoningSummaries: false,
          showSessionProgressBar: true,
          ...settings,
        },
      }),
    )
    if (settings.newLayoutDesigns === false) {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
    }
  }, input.settings ?? {})
  if (input.locale) {
    await page.addInitScript((locale) => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
    }, input.locale)
  }
  if (input.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize(input.viewport ?? { width: 1400, height: 900 })
  if (input.deviceScaleFactor) {
    const devtools = await page.context().newCDPSession(page)
    const viewport = input.viewport ?? { width: 1400, height: 900 }
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: input.deviceScaleFactor,
      mobile: false,
    })
  }
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  if (input.cpuRate && input.cpuRate > 1) {
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: input.cpuRate })
  }

  const sendEvent = async (input: TimelineEvent | readonly TimelineEvent[], delay = 0) => {
    for (const item of Array.isArray(input) ? input : [input]) {
      const valid = validateTimelineEvent(item)
      await transport.send(valid, { marker: describeEvent(valid) })
    }
    if (delay) await page.waitForTimeout(delay)
  }

  return {
    transport,
    send: sendEvent,
    async sendAll(sequence: { event: TimelineEvent | readonly TimelineEvent[]; delay: number }[]) {
      for (const item of sequence) {
        await sendEvent(item.event, item.delay)
      }
    },
    async settle(frames = 3) {
      await page.evaluate(
        (frames) =>
          new Promise<void>((resolve) => {
            let remaining = frames
            const tick = () => {
              remaining--
              if (remaining <= 0) return resolve()
              requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        frames,
      )
    },
    async waitForPart(partID: string) {
      const part = page.locator(`[data-timeline-part-id="${partID}"]`)
      await expect(part).toHaveCount(1)
      await expect(part).toBeVisible()
    },
  }
}

function resetProducerState(messages: readonly TimelineMessage[]) {
  seededToolStatus.clear()
  liveToolStatus.clear()
  streamedParts.clear()
  timestampSequence = 0
  messages.forEach((message) => {
    if (message.info.role !== "assistant") return
    message.parts.forEach((part) => {
      if (part.type === "tool") {
        seededToolStatus.set(part.id, part.state.status)
        liveToolStatus.set(part.id, part.state.status)
      }
      if (part.type === "text" || part.type === "reasoning") streamedParts.add(part.id)
    })
  })
}

function nextTimestamp() {
  return 1700000002000 + ++timestampSequence * 100
}

function describeEvent(event: EventPayload) {
  if ("payload" in event) return event.payload.type
  const data: Record<string, unknown> = event.data
  const subject = [data.callID, data.textID, data.reasoningID, data.assistantMessageID, data.sessionID].find(
    (value) => typeof value === "string",
  )
  return [event.type, subject].filter(Boolean).join(":")
}

export function event<const Type extends LegacyPayloadType>(
  type: Type,
  properties: { sessionID: string; messageID: string; partID?: string },
): LegacyEvent {
  return {
    directory,
    payload: { id: `evt_timeline_${String(++eventSequence).padStart(4, "0")}`, type, properties },
  }
}

export function v2Event<const Type extends TimelinePayload["type"]>(
  type: Type,
  data: Extract<TimelinePayload, { type: Type }>["data"],
): TimelinePayload {
  const value = { id: `evt_timeline_${String(++eventSequence).padStart(4, "0")}`, type, location: { directory }, data }
  return encodeV2Event(decodeV2Event(value, decodeOptions)) as TimelinePayload
}

export function validateTimelineEvent(input: unknown): TimelineEvent {
  if (input && typeof input === "object" && "payload" in input) return decodeLegacyEvent(input) as LegacyEvent
  return v2EventUntyped(input)
}

function v2EventUntyped(input: unknown): TimelinePayload {
  return encodeV2Event(decodeV2Event(input, decodeOptions)) as TimelinePayload
}

export function validateTimelineMessages(input: readonly TimelineMessage[]): TimelineMessage[] {
  input.forEach((message) => decodeMessage(message, decodeOptions))
  const messages = [...input]
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  const users = new Set(messages.filter((message) => message.info.role === "user").map((message) => message.info.id))

  messages.forEach((message) => {
    if (messageIDs.has(message.info.id))
      throw new Error(`Timeline fixture has duplicate message ID: ${message.info.id}`)
    messageIDs.add(message.info.id)
    if (message.info.role === "assistant" && !users.has(message.info.parentID))
      throw new Error(`Timeline assistant ${message.info.id} must reference a parent user in the fixture`)
    message.parts.forEach((part) => {
      if (part.sessionID !== message.info.sessionID || part.messageID !== message.info.id)
        throw new Error(`Timeline part ${part.id} ownership does not match message ${message.info.id}`)
      if (message.info.role === "user" && !["text", "file", "agent", "subtask"].includes(part.type))
        throw new Error(`Timeline user message ${message.info.id} cannot own ${part.type} part ${part.id}`)
      if (message.info.role === "assistant" && ["agent", "subtask"].includes(part.type))
        throw new Error(`Timeline assistant message ${message.info.id} cannot own ${part.type} part ${part.id}`)
      if (partIDs.has(part.id)) throw new Error(`Timeline fixture has duplicate part ID: ${part.id}`)
      partIDs.add(part.id)
    })
  })
  return messages
}

export async function waitForVisualSettle(page: Page, selectors: string[], stableFrames = 3) {
  await page.waitForFunction(
    ({ selectors, stableFrames }) => {
      const elements = selectors.map((selector) => document.querySelector<HTMLElement>(selector))
      if (elements.some((element) => !element)) return false
      return new Promise<boolean>((resolve) => {
        let stable = 0
        let previous = ""
        const sample = () => {
          const signature = JSON.stringify(
            elements.map((element) => {
              const rect = element!.getBoundingClientRect()
              return [Math.round(rect.top * 10), Math.round(rect.bottom * 10), Math.round(rect.height * 10)]
            }),
          )
          stable = signature === previous ? stable + 1 : 0
          previous = signature
          const ordered = elements
            .slice(1)
            .every(
              (element, index) =>
                elements[index]!.getBoundingClientRect().bottom <= element!.getBoundingClientRect().top + 0.5,
            )
          if (stable >= stableFrames && ordered) return resolve(true)
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
    },
    { selectors, stableFrames },
  )
}

export function historyMessages(count: number): TimelineMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(4, "0")
    const historyUserID = `msg_0${value}_history_a_user`
    return [
      userMessage(undefined, { id: historyUserID, created: 1690000000000 + index * 10_000 }),
      assistantMessage(
        [
          {
            id: `prt_0${value}_history_text`,
            type: "text",
            text: `Historical response ${index}. ${"Existing session content keeps the virtual timeline realistic. ".repeat(5)}`,
          },
        ],
        {
          id: `msg_0${value}_history_b_assistant`,
          parentID: historyUserID,
          created: 1690000001000 + index * 10_000,
        },
      ),
    ]
  }).flat()
}

export function partUpdated(part: Part | PartSeed<"assistant">): TimelineEvent[] {
  const owned = "messageID" in part ? part : { ...part, sessionID, messageID: assistantID }
  decodePart(owned, decodeOptions)
  if (owned.type === "text") return textEvents(owned.id, owned.text ?? "", owned.messageID)
  if (owned.type === "reasoning") return reasoningEvents(owned.id, owned.text ?? "", owned.messageID)
  if (owned.type === "tool") return toolEvents(owned)
  return []
}

function textEvents(partID: string, text: string, messageID: string): TimelineEvent[] {
  const events: TimelineEvent[] = []
  if (!streamedParts.has(partID)) {
    streamedParts.add(partID)
    events.push(
      v2Event("session.next.text.started", {
        sessionID,
        timestamp: nextTimestamp(),
        assistantMessageID: messageID,
        textID: partID,
      }),
    )
  }
  events.push(
    v2Event("session.next.text.ended", {
      sessionID,
      timestamp: nextTimestamp(),
      assistantMessageID: messageID,
      textID: partID,
      text,
    }),
  )
  return events
}

function reasoningEvents(partID: string, text: string, messageID: string): TimelineEvent[] {
  const events: TimelineEvent[] = []
  if (!streamedParts.has(partID)) {
    streamedParts.add(partID)
    events.push(
      v2Event("session.next.reasoning.started", {
        sessionID,
        timestamp: nextTimestamp(),
        assistantMessageID: messageID,
        reasoningID: partID,
      }),
    )
  }
  events.push(
    v2Event("session.next.reasoning.ended", {
      sessionID,
      timestamp: nextTimestamp(),
      assistantMessageID: messageID,
      reasoningID: partID,
      text,
    }),
  )
  return events
}

/**
 * Re-deliver a settled part through the legacy part bridge: V2 producers never
 * mutate a settled tool, but pre-V2 servers re-deliver `message.part.updated`,
 * which the app mirrors into the V2 records.
 */
function legacyPartUpdated(part: Extract<Part, { type: "tool" }>): LegacyEvent {
  return {
    directory,
    payload: {
      id: `evt_timeline_${String(++eventSequence).padStart(4, "0")}`,
      type: "message.part.updated",
      properties: { sessionID, messageID: part.messageID, part },
    },
  }
}

function toolEvents(part: Extract<Part, { type: "tool" }>): TimelineEvent[] {
  const state = part.state
  if (state.status === "pending") return []
  const base = { sessionID, assistantMessageID: part.messageID, callID: part.id }
  const known = liveToolStatus.has(part.id)
  const started = () =>
    v2Event("session.next.tool.input.started", {
      ...base,
      timestamp: nextTimestamp(),
      name: part.tool,
    })
  const called = (input: Record<string, unknown>) =>
    v2Event("session.next.tool.called", {
      ...base,
      timestamp: nextTimestamp(),
      tool: part.tool,
      input,
      provider: { executed: false },
    })
  const current = liveToolStatus.get(part.id) ?? "pending"
  if (state.status === "running") {
    if (current === "running")
      return [
        v2Event("session.next.tool.progress", {
          ...base,
          timestamp: nextTimestamp(),
          structured: state.metadata ?? {},
          content: [],
        }),
      ]
    liveToolStatus.set(part.id, "running")
    if (known) return [called(state.input)]
    return [started(), called(state.input)]
  }
  if (state.status === "error") {
    if (current === "error") {
      // A settled tool can only change content through the legacy part bridge
      // (a pre-V2 server re-delivering the part); V2 has no such mutation.
      return [legacyPartUpdated(part)]
    }
    if (current === "completed") return []
    liveToolStatus.set(part.id, "error")
    const failed = v2Event("session.next.tool.failed", {
      ...base,
      timestamp: nextTimestamp(),
      error: { type: "unknown", message: state.error ?? "Tool failed" },
      provider: { executed: false },
    })
    return known ? [failed] : [started(), failed]
  }
  if (current === "completed") {
    // Settled output updates re-deliver through the legacy part bridge.
    return [legacyPartUpdated(part)]
  }
  liveToolStatus.set(part.id, "completed")
  const success = () =>
    v2Event("session.next.tool.success", {
      ...base,
      timestamp: nextTimestamp(),
      structured: state.metadata ?? {},
      content: [{ type: "text", text: state.output }],
      provider: { executed: false },
    })
  if (current === "running") return [success()]
  if (known) return [called(state.input), success()]
  return [started(), called(state.input), success()]
}

export function partDelta(partID: string, delta: string, messageID = assistantID) {
  return v2Event("session.next.text.delta", {
    sessionID,
    timestamp: nextTimestamp(),
    assistantMessageID: messageID,
    textID: partID,
    delta,
  })
}

export function messageUpdated(info: AssistantMessage): TimelineEvent[] {
  if (info.error) {
    const data = info.error.data
    const message = !!data && typeof data === "object" && typeof data.message === "string" ? data.message : info.error.name
    return [
      v2Event("session.next.step.failed", {
        sessionID,
        timestamp: nextTimestamp(),
        assistantMessageID: info.id,
        error: { type: "unknown", message },
      }),
    ]
  }
  return [
    v2Event("session.next.step.ended", {
      sessionID,
      timestamp: info.time.completed ?? nextTimestamp(),
      assistantMessageID: info.id,
      finish: "stop",
      cost: info.cost ?? 0,
      tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
}

export function status(type: SessionStatus["type"], attempt = 1, message = "Rate limited"): TimelineEvent {
  return v2Event("session.next.status", {
    sessionID,
    timestamp: nextTimestamp(),
    status: type === "retry" ? { type, attempt, message, next: 1700000010000 } : { type },
  })
}

export function userMessage(
  parts?: PartSeed<"user">[],
  input: { id?: string; summary?: UserMessage["summary"]; created?: number } = {},
): Extract<TimelineMessage, { info: { role: "user" } }> {
  const id = input.id ?? userID
  const seeds = parts ?? [userText("Build the timeline stability matrix.", { id: `prt_${id}_text` })]
  const message = {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: input.created ?? 1700000000000 },
      summary: input.summary ?? { diffs: [] },
      agent: "build",
      model,
    },
    parts: seeds.map((part) => ({
      ...part,
      sessionID,
      messageID: id,
    })),
  } satisfies Extract<TimelineMessage, { info: { role: "user" } }>
  decodeMessage(message, decodeOptions)
  return message
}

export function assistantMessage(
  parts: PartSeed<"assistant">[] = [],
  input: {
    id?: string
    parentID?: string
    completed?: boolean
    error?: AssistantMessage["error"]
    finish?: string
    created?: number
  } = {},
): Extract<TimelineMessage, { info: { role: "assistant" } }> {
  const id = input.id ?? assistantID
  const message = {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: {
        created: input.created ?? 1700000001000,
        ...(input.completed === false ? {} : { completed: (input.created ?? 1700000001000) + 1_000 }),
      },
      parentID: input.parentID ?? userID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: "max",
      ...(input.error ? { error: input.error } : {}),
      ...(input.finish ? { finish: input.finish } : {}),
    },
    parts: parts.map((part) => ({ ...part, sessionID, messageID: id })),
  } satisfies Extract<TimelineMessage, { info: { role: "assistant" } }>
  decodeMessage(message, decodeOptions)
  return message
}

export function userText(
  text: string,
  input: Partial<Omit<Extract<PartSeed<"user">, { type: "text" }>, "type" | "text">> = {},
): Extract<PartSeed<"user">, { type: "text" }> {
  return { id: "prt_user_text", type: "text", text, ...input }
}

export function textPart(id: string, text: string): Extract<PartSeed<"assistant">, { type: "text" }> {
  return { id, type: "text", text }
}

export function reasoningPart(id: string, text: string): Extract<PartSeed<"assistant">, { type: "reasoning" }> {
  return { id, type: "reasoning", text, time: { start: 1700000001000 } }
}

export function toolPart(
  id: string,
  tool: string,
  state: "pending",
  input: Record<string, unknown>,
  options?: ToolOptions<"pending">,
): Omit<ToolPart, "sessionID" | "messageID">
export function toolPart(
  id: string,
  tool: string,
  state: "running",
  input: Record<string, unknown>,
  options?: ToolOptions<"running">,
): Omit<ToolPart, "sessionID" | "messageID">
export function toolPart(
  id: string,
  tool: string,
  state: "completed",
  input: Record<string, unknown>,
  options?: ToolOptions<"completed">,
): Omit<ToolPart, "sessionID" | "messageID">
export function toolPart(
  id: string,
  tool: string,
  state: "error",
  input: Record<string, unknown>,
  options?: ToolOptions<"error">,
): Omit<ToolPart, "sessionID" | "messageID">
export function toolPart(
  id: string,
  tool: string,
  state: ToolStatus,
  input: Record<string, unknown>,
  options: ToolOptions<ToolStatus> = {},
): Omit<ToolPart, "sessionID" | "messageID"> {
  const base = { id, type: "tool" as const, callID: `call_${id}`, tool }
  if (state === "pending") return { ...base, state: { status: state, input, raw: "" } }
  if (state === "running")
    return {
      ...base,
      state: {
        status: state,
        input,
        title: options.title,
        metadata: options.metadata ?? {},
        time: { start: 1700000001000 },
      },
    }
  if (state === "error")
    return {
      ...base,
      state: {
        status: state,
        input,
        error: options.error ?? "Tool failed",
        metadata: options.metadata ?? {},
        time: { start: 1700000001000, end: 1700000002000 },
      },
    }
  return {
    ...base,
    state: {
      status: state,
      input,
      output: options.output ?? "Completed",
      title: options.title ?? tool,
      metadata: options.metadata ?? {},
      time: { start: 1700000001000, end: 1700000002000 },
    },
  }
}

export function shell(
  id: string,
  state: ToolStatus,
  output = "",
  command = `echo ${id}`,
): Omit<ToolPart, "sessionID" | "messageID"> {
  if (state === "pending") return toolPart(id, "bash", state, { command })
  if (state === "running")
    return toolPart(id, "bash", state, { command }, { title: command, metadata: { command, output } })
  if (state === "error")
    return toolPart(id, "bash", state, { command }, { error: output || undefined, metadata: { command, output } })
  return toolPart(id, "bash", state, { command }, { title: command, output, metadata: { command, output } })
}

export function completedAssistantInfo(info: AssistantMessage): AssistantMessage {
  return { ...info, time: { ...info.time, completed: 1700000003000 } }
}

/**
 * The timeline DOM derives text and reasoning part ids from the record content
 * ordinal, not the content id (`${messageID}:${type}:${ordinal}`). Tool parts
 * keep their call/content id.
 */
export function sessionPartID(messageID: string, type: "text" | "reasoning", ordinal: number) {
  return `${messageID}:${type}:${ordinal}`
}

export function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "timeline-stability",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

export function session(input: Partial<Session> = {}): Session {
  return {
    id: sessionID,
    slug: "timeline-stability",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
    ...input,
  }
}

function eventSchema<
  const Type extends LegacyPayloadType,
  const Properties extends Schema.Codec<unknown, unknown>,
>(type: Type, properties: Properties) {
  return Schema.Struct({
    directory: Schema.String,
    payload: Schema.Struct({ id: Event.ID, type: Schema.Literal(type), properties }),
  })
}

/**
 * Project a seed message into the V2 `SessionMessage` record the app stores.
 * Tool content keeps the seed part id (the timeline addresses tools by it);
 * text and reasoning carry the id too so live deltas can target seeded content.
 */
function toRecord(message: TimelineMessage): SessionMessage.Message {
  if (message.info.role === "user") {
    return {
      id: message.info.id,
      type: "user",
      time: { created: message.info.time.created },
      text: message.parts
        .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n"),
    }
  }
  const info = message.info
  return {
    id: info.id,
    type: "assistant",
    time: info.time,
    agent: info.agent ?? "build",
    model: { id: info.modelID ?? model.modelID, providerID: info.providerID ?? model.providerID },
    ...(info.cost !== undefined ? { cost: info.cost } : {}),
    ...(info.tokens ? { tokens: info.tokens } : {}),
    ...(info.finish === "stop" || info.finish === "tool-calls" ? { finish: info.finish } : {}),
    ...(info.error ? { error: { type: "unknown", message: errorMessage(info.error) } } : {}),
    content: message.parts.flatMap((part) => {
      if (part.type === "text") return [{ type: "text", id: part.id, text: part.text ?? "" }]
      if (part.type === "reasoning")
        return [
          {
            type: "reasoning",
            id: part.id,
            text: part.text ?? "",
            time: { created: part.time?.start ?? info.time.created },
          },
        ]
      if (part.type !== "tool") return []
      return [toolContent(part, info.time.created ?? 1700000001000)]
    }),
  }
}

function errorMessage(error: AssistantMessage["error"]) {
  const data = error?.data
  return !!data && typeof data === "object" && typeof data.message === "string" ? data.message : (error?.name ?? "failed")
}

function toolContent(part: Extract<Part, { type: "tool" }>, created: number): SessionMessage.AssistantContent {
  const state = part.state
  const start = state.status === "pending" ? created : state.time.start
  const base = {
    type: "tool" as const,
    id: part.id,
    name: part.tool,
    time: {
      created: start,
      ...(state.status !== "pending" && state.time.start !== undefined ? { ran: state.time.start } : {}),
      ...(state.status === "completed" || state.status === "error" ? { completed: state.time.end } : {}),
    },
  }
  if (state.status === "pending")
    return { ...base, state: { status: "pending", input: JSON.stringify(state.input ?? {}) } }
  if (state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: state.input,
        structured: state.metadata ?? {},
        content: [],
      },
    }
  if (state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: state.input,
        structured: state.metadata ?? {},
        content: [],
        error: { type: "unknown", message: state.error ?? "Tool failed" },
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input: state.input,
      structured: state.metadata ?? {},
      content: [{ type: "text", text: state.output }],
    },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}
