// Subagent tabs and their inspector detail for direct interactive mode.
//
// A V2 `task` call learns its child session only when the call settles, so a
// running call is linked to the child whose `session.next.created` names the
// root as parent, in call order.
import type { Message, Part, PermissionRequest, QuestionRequest, ToolPart } from "@miao/sdk/v2"
import * as Locale from "@/util/locale"
import {
  bootstrapSessionData,
  createSessionData,
  failureText,
  reduceSessionData,
  type SessionData,
  type SessionDataEvent,
} from "./session-data"
import { INTERRUPTED_STEP, liveToolPart, partKey } from "./session-v2"
import type { FooterSubagentState, FooterSubagentTab, StreamCommit } from "./types"

export const SUBAGENT_BOOTSTRAP_LIMIT = 200
export const SUBAGENT_CALL_BOOTSTRAP_LIMIT = 80

const SUBAGENT_COMMIT_LIMIT = 80
const SUBAGENT_CALL_LIMIT = 32
const SUBAGENT_ROLE_LIMIT = 32
const SUBAGENT_ERROR_LIMIT = 16
const SUBAGENT_ECHO_LIMIT = 8

type SessionMessage = {
  parts: Part[]
}

type BootstrapChildMessage = SessionMessage & {
  info: Message
}

type Frame = {
  key: string
  commit: StreamCommit
}

type DetailState = {
  sessionID: string
  data: SessionData
  frames: Frame[]
}

// A root `task` call awaiting or holding its child session.
type TaskCall = {
  messageID: string
  callID: string
  input: Record<string, unknown>
  created: number
  sessionID?: string
}

export type SubagentData = {
  tabs: Map<string, FooterSubagentTab>
  details: Map<string, DetailState>
  tasks: Map<string, TaskCall>
}

export type BootstrapSubagentInput = {
  data: SubagentData
  messages: SessionMessage[]
  children: Array<{ id: string; title?: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

function createDetail(sessionID: string): DetailState {
  return {
    sessionID,
    data: createSessionData({
      includeUserText: true,
    }),
    frames: [],
  }
}

function ensureDetail(data: SubagentData, sessionID: string) {
  const current = data.details.get(sessionID)
  if (current) {
    return current
  }

  const next = createDetail(sessionID)
  data.details.set(sessionID, next)
  return next
}

export function sameSubagentTab(a: FooterSubagentTab | undefined, b: FooterSubagentTab | undefined) {
  if (!a || !b) {
    return false
  }

  return (
    a.sessionID === b.sessionID &&
    a.partID === b.partID &&
    a.callID === b.callID &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status &&
    a.background === b.background &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.lastUpdatedAt === b.lastUpdatedAt
  )
}

function sameQueue<T extends { id: string }>(left: T[], right: T[]) {
  return (
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item === right[index])
  )
}

function queueSnapshot(data: SessionData) {
  return {
    permissions: data.permissions.slice(),
    questions: data.questions.slice(),
  }
}

function queueChanged(data: SessionData, before: ReturnType<typeof queueSnapshot>) {
  return !sameQueue(before.permissions, data.permissions) || !sameQueue(before.questions, data.questions)
}

function sameCommit(left: StreamCommit, right: StreamCommit) {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.phase === right.phase &&
    left.source === right.source &&
    left.messageID === right.messageID &&
    left.partID === right.partID &&
    left.tool === right.tool &&
    left.interrupted === right.interrupted &&
    left.toolState === right.toolState &&
    left.toolError === right.toolError
  )
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const next = value.trim()
  return next || undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return undefined
}

function inputLabel(input: Record<string, unknown>): string | undefined {
  const description = text(input.description)
  if (description) {
    return description
  }

  const command = text(input.command)
  if (command) {
    return command
  }

  const filePath = text(input.filePath) ?? text(input.filepath)
  if (filePath) {
    return filePath
  }

  const pattern = text(input.pattern)
  if (pattern) {
    return pattern
  }

  const query = text(input.query)
  if (query) {
    return query
  }

  const url = text(input.url)
  if (url) {
    return url
  }

  const path = text(input.path)
  if (path) {
    return path
  }

  const prompt = text(input.prompt)
  if (prompt) {
    return prompt
  }

  return undefined
}

function stateTitle(part: ToolPart) {
  return text("title" in part.state ? part.state.title : undefined)
}

function callKey(messageID: string | undefined, callID: string | undefined): string | undefined {
  if (!messageID || !callID) {
    return undefined
  }

  return `${messageID}:${callID}`
}

function compactToolState(part: ToolPart): ToolPart["state"] {
  if (part.state.status === "pending") {
    return {
      status: "pending",
      input: part.state.input,
      raw: part.state.raw,
    }
  }

  if (part.state.status === "running") {
    return {
      status: "running",
      input: part.state.input,
      time: part.state.time,
      ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      ...(part.state.title ? { title: part.state.title } : {}),
    }
  }

  if (part.state.status === "completed") {
    return {
      status: "completed",
      input: part.state.input,
      output: part.state.output,
      title: part.state.title,
      metadata: part.state.metadata,
      time: part.state.time,
    }
  }

  return {
    status: "error",
    input: part.state.input,
    error: part.state.error,
    time: part.state.time,
    ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
  }
}

function recent<T>(input: Iterable<T>, limit: number) {
  const list = [...input]
  return list.slice(Math.max(0, list.length - limit))
}

function copyMap<K, V>(source: Map<K, V>, keep: Set<K>) {
  const out = new Map<K, V>()
  for (const [key, value] of source) {
    if (!keep.has(key)) {
      continue
    }

    out.set(key, value)
  }
  return out
}

function compactToolPart(part: ToolPart): ToolPart {
  return {
    id: part.id,
    type: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    state: compactToolState(part),
    ...(part.metadata ? { metadata: part.metadata } : {}),
  }
}

function compactCommit(commit: StreamCommit): StreamCommit {
  if (!commit.part) {
    return commit
  }

  return {
    ...commit,
    part: compactToolPart(commit.part),
  }
}

function stateUpdatedAt(part: ToolPart) {
  if (!("time" in part.state)) {
    return Date.now()
  }

  const time = part.state.time
  if (!("end" in time)) {
    return time.start ?? Date.now()
  }

  return time.end ?? time.start ?? Date.now()
}

function metadata(part: ToolPart, key: string) {
  return ("metadata" in part.state ? part.state.metadata?.[key] : undefined) ?? part.metadata?.[key]
}

// V1 and V2 wording for a tool call cut short by an interrupt.
const ABORTED_TOOL = new Set(["Tool execution aborted", "Tool execution interrupted"])

function taskStatus(part: ToolPart): FooterSubagentTab["status"] {
  if (part.state.status === "completed") {
    return "completed"
  }

  if (part.state.status === "error") {
    if (metadata(part, "interrupted") === true || ABORTED_TOOL.has(text(part.state.error) ?? "")) {
      return "cancelled"
    }

    return "error"
  }

  return "running"
}

function taskTab(part: ToolPart, sessionID: string): FooterSubagentTab {
  const label = Locale.titlecase(text(part.state.input.subagent_type) ?? "general")
  const description = text(part.state.input.description) ?? stateTitle(part) ?? inputLabel(part.state.input) ?? ""

  return {
    sessionID,
    partID: part.id,
    callID: part.callID,
    label,
    description,
    status: taskStatus(part),
    background: metadata(part, "background") === true,
    title: stateTitle(part),
    toolCalls: num(metadata(part, "toolcalls")) ?? num(metadata(part, "toolCalls")) ?? num(metadata(part, "calls")),
    lastUpdatedAt: stateUpdatedAt(part),
  }
}

function taskSessionID(part: ToolPart) {
  return text(metadata(part, "sessionId")) ?? text(metadata(part, "sessionID"))
}

function syncTaskTab(data: SubagentData, part: ToolPart, children?: Set<string>) {
  if (part.tool !== "task") {
    return false
  }

  const sessionID = taskSessionID(part)
  if (!sessionID) {
    return false
  }

  if (children && children.size > 0 && !children.has(sessionID)) {
    return false
  }

  const next = taskTab(part, sessionID)
  if (sameSubagentTab(data.tabs.get(sessionID), next)) {
    ensureDetail(data, sessionID)
    return false
  }

  data.tabs.set(sessionID, next)
  ensureDetail(data, sessionID)
  return true
}

function frameKey(commit: StreamCommit) {
  if (commit.partID) {
    return `${commit.kind}:${commit.partID}:${commit.phase}`
  }

  if (commit.messageID) {
    return `${commit.kind}:${commit.messageID}:${commit.phase}`
  }

  return `${commit.kind}:${commit.phase}:${commit.text}`
}

function limitFrames(detail: DetailState) {
  if (detail.frames.length <= SUBAGENT_COMMIT_LIMIT) {
    return
  }

  detail.frames.splice(0, detail.frames.length - SUBAGENT_COMMIT_LIMIT)
}

function mergeLiveCommit(current: StreamCommit, next: StreamCommit) {
  if (current.phase !== "progress" || next.phase !== "progress") {
    if (sameCommit(current, next)) {
      return current
    }

    return next
  }

  const merged = {
    ...current,
    ...next,
    text: current.text + next.text,
  }

  if (sameCommit(current, merged)) {
    return current
  }

  return merged
}

function appendCommits(detail: DetailState, commits: StreamCommit[]) {
  let changed = false

  for (const commit of commits.map(compactCommit)) {
    const key = frameKey(commit)
    const index = detail.frames.findIndex((item) => item.key === key)
    if (index === -1) {
      detail.frames.push({
        key,
        commit,
      })
      changed = true
      continue
    }

    const next = mergeLiveCommit(detail.frames[index].commit, commit)
    if (sameCommit(detail.frames[index].commit, next)) {
      continue
    }

    detail.frames[index] = {
      key,
      commit: next,
    }
    changed = true
  }

  if (changed) {
    limitFrames(detail)
  }

  return changed
}

function ensureBlockerTab(
  data: SubagentData,
  sessionID: string,
  title: string | undefined,
  kind: "permission" | "question",
) {
  const current = data.tabs.get(sessionID)
  if (current) {
    ensureDetail(data, sessionID)
    if (current.status !== "running") {
      return false
    }

    const next = {
      ...current,
      description: kind === "permission" ? "Pending permission" : "Pending question",
      status: "running" as const,
      title: current.title ?? title,
      lastUpdatedAt: Date.now(),
    }
    if (sameSubagentTab(current, next)) {
      return false
    }

    data.tabs.set(sessionID, next)
    return true
  }

  data.tabs.set(sessionID, {
    sessionID,
    partID: `bootstrap:${sessionID}`,
    callID: `bootstrap:${sessionID}`,
    label: text(title) ?? Locale.titlecase(kind),
    description: kind === "permission" ? "Pending permission" : "Pending question",
    status: "running",
    lastUpdatedAt: Date.now(),
  })
  ensureDetail(data, sessionID)
  return true
}

function cancelSubagentTab(data: SubagentData, sessionID: string) {
  const current = data.tabs.get(sessionID)
  if (!current || current.status !== "running") {
    return false
  }

  const next = {
    ...current,
    status: "cancelled" as const,
    lastUpdatedAt: Date.now(),
  }
  if (sameSubagentTab(current, next)) {
    return false
  }

  data.tabs.set(sessionID, next)
  return true
}

function compactCallMap(detail: DetailState) {
  const keep = new Set(recent(detail.data.call.keys(), SUBAGENT_CALL_LIMIT))

  for (const request of detail.data.permissions) {
    const key = callKey(request.tool?.messageID, request.tool?.callID)
    if (key) {
      keep.add(key)
    }
  }

  for (const item of detail.frames) {
    const key = callKey(item.commit.part?.messageID, item.commit.part?.callID)
    if (key) {
      keep.add(key)
    }
  }

  return copyMap(detail.data.call, keep)
}

function compactEchoMap(data: SessionData, messageIDs: Set<string>) {
  const keys = new Set([...messageIDs, ...recent(data.echo.keys(), SUBAGENT_ECHO_LIMIT)])
  return copyMap(data.echo, keys)
}

function compactIDs(detail: DetailState) {
  return new Set(recent(detail.data.ids, SUBAGENT_COMMIT_LIMIT + SUBAGENT_ERROR_LIMIT))
}

function compactDetail(detail: DetailState) {
  const next = createSessionData({
    includeUserText: true,
  })
  const activePartIDs = new Set(detail.data.part.keys())
  const framePartIDs = new Set(detail.frames.flatMap((item) => (item.commit.partID ? [item.commit.partID] : [])))
  const partIDs = new Set([...activePartIDs, ...framePartIDs, ...detail.data.tools])
  const messageIDs = new Set([
    ...[...activePartIDs]
      .map((partID) => detail.data.msg.get(partID))
      .filter((item): item is string => typeof item === "string"),
    ...recent(detail.data.role.keys(), SUBAGENT_ROLE_LIMIT),
  ])

  next.announced = detail.data.announced
  next.permissions = detail.data.permissions
  next.questions = detail.data.questions
  next.ids = compactIDs(detail)
  next.tools = new Set([...detail.data.tools].filter((item) => partIDs.has(item)))
  next.call = compactCallMap(detail)
  next.role = copyMap(detail.data.role, messageIDs)
  next.msg = copyMap(detail.data.msg, activePartIDs)
  next.part = copyMap(detail.data.part, activePartIDs)
  next.text = copyMap(detail.data.text, activePartIDs)
  next.sent = copyMap(detail.data.sent, activePartIDs)
  next.end = new Set([...detail.data.end].filter((item) => activePartIDs.has(item)))
  next.echo = compactEchoMap(detail.data, messageIDs)
  next.steps = new Map(recent(detail.data.steps.entries(), SUBAGENT_ROLE_LIMIT))
  // In-flight calls hold the tool name and input their settlement needs.
  next.calls = detail.data.calls
  next.retrying = detail.data.retrying
  detail.data = next
}

function applyChildEvent(input: {
  detail: DetailState
  event: SessionDataEvent
  thinking: boolean
  limits: Record<string, number>
}) {
  const before = queueSnapshot(input.detail.data)
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })
  const changed = appendCommits(input.detail, out.commits)
  compactDetail(input.detail)

  return changed || queueChanged(input.detail.data, before)
}

function bootstrapChildEvent(input: {
  detail: DetailState
  event: SessionDataEvent
  thinking: boolean
  limits: Record<string, number>
}) {
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })

  return appendCommits(input.detail, out.commits)
}

function bootstrapChildMessages(input: {
  detail: DetailState
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  let changed = false

  for (const message of input.messages) {
    changed =
      bootstrapChildEvent({
        detail: input.detail,
        event: {
          id: `bootstrap:message:${message.info.id}`,
          type: "message.updated",
          properties: {
            sessionID: input.detail.sessionID,
            info: message.info,
          },
        },
        thinking: input.thinking,
        limits: input.limits,
      }) || changed

    for (const part of message.parts) {
      changed =
        bootstrapChildEvent({
          detail: input.detail,
          event: {
            id: `bootstrap:part:${part.id}`,
            type: "message.part.updated",
            properties: {
              sessionID: input.detail.sessionID,
              part,
              time: 0,
            },
          },
          thinking: input.thinking,
          limits: input.limits,
        }) || changed
    }
  }

  compactDetail(input.detail)
  return changed
}

function knownSession(data: SubagentData, sessionID: string) {
  return data.tabs.has(sessionID)
}

export function listSubagentPermissions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.permissions)
}

export function listSubagentQuestions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.questions)
}

export function createSubagentData(): SubagentData {
  return {
    tabs: new Map(),
    details: new Map(),
    tasks: new Map(),
  }
}

function snapshotDetail(detail: DetailState) {
  return {
    sessionID: detail.sessionID,
    commits: detail.frames.map((item) => item.commit),
  }
}

export function listSubagentTabs(data: SubagentData) {
  return [...data.tabs.values()].sort((a, b) => {
    const active = Number(b.status === "running") - Number(a.status === "running")
    if (active !== 0) {
      return active
    }

    return b.lastUpdatedAt - a.lastUpdatedAt
  })
}

function snapshotQueues(data: SubagentData) {
  return {
    permissions: listSubagentPermissions(data).sort((a, b) => a.id.localeCompare(b.id)),
    questions: listSubagentQuestions(data).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function snapshotState(data: SubagentData, details: FooterSubagentState["details"]): FooterSubagentState {
  return {
    tabs: listSubagentTabs(data),
    details,
    ...snapshotQueues(data),
  }
}

export function snapshotSubagentData(data: SubagentData): FooterSubagentState {
  return snapshotState(
    data,
    Object.fromEntries([...data.details.entries()].map(([sessionID, detail]) => [sessionID, snapshotDetail(detail)])),
  )
}

export function snapshotSelectedSubagentData(
  data: SubagentData,
  selectedSessionID: string | undefined,
): FooterSubagentState {
  const detail = selectedSessionID ? data.details.get(selectedSessionID) : undefined

  return snapshotState(data, detail ? { [detail.sessionID]: snapshotDetail(detail) } : {})
}

export function bootstrapSubagentData(input: BootstrapSubagentInput) {
  const child = new Map(input.children.map((item) => [item.id, item]))
  const children = new Set(child.keys())
  let changed = false

  const tasks = input.messages.flatMap((message) =>
    message.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task"),
  )
  for (const part of tasks) {
    changed = syncTaskTab(input.data, part, children) || changed
  }

  // A task still running when the transcript was read has not reported its
  // child yet; pair those calls with the children that have no tab, in order.
  // A call whose child does not exist yet waits for its `session.next.created`.
  const unlinked = input.children.filter((item) => !input.data.tabs.has(item.id))
  for (const [index, part] of tasks.filter((part) => part.state.status === "running").entries()) {
    const sessionID = unlinked[index]?.id
    input.data.tasks.set(part.id, {
      messageID: part.messageID,
      callID: part.callID,
      input: part.state.input,
      created: "time" in part.state ? part.state.time.start : Date.now(),
      sessionID,
    })
    if (!sessionID) {
      continue
    }

    changed =
      syncTaskTab(input.data, { ...part, metadata: { ...part.metadata, sessionId: sessionID } }, children) || changed
  }

  for (const item of input.permissions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "permission") || changed
  }

  for (const item of input.questions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "question") || changed
  }

  for (const sessionID of input.data.tabs.keys()) {
    const detail = ensureDetail(input.data, sessionID)
    const before = queueSnapshot(detail.data)

    bootstrapSessionData({
      data: detail.data,
      messages: [],
      permissions: input.permissions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
      questions: input.questions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
    compactDetail(detail)

    changed = queueChanged(detail.data, before) || changed
  }

  return changed
}

export function bootstrapSubagentCalls(input: {
  data: SubagentData
  sessionID: string
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  if (!knownSession(input.data, input.sessionID) || input.messages.length === 0) {
    return false
  }

  const detail = ensureDetail(input.data, input.sessionID)
  const before = queueSnapshot(detail.data)
  const beforeCallCount = detail.data.call.size
  bootstrapSessionData({
    data: detail.data,
    messages: input.messages,
    permissions: detail.data.permissions,
    questions: detail.data.questions,
  })
  const changed = bootstrapChildMessages({
    detail,
    messages: input.messages,
    thinking: input.thinking,
    limits: input.limits,
  })

  return changed || beforeCallCount !== detail.data.call.size || queueChanged(detail.data, before)
}

export function reduceSubagentData(input: {
  data: SubagentData
  event: SessionDataEvent
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}) {
  const event = input.event
  if (
    event.type === "message.updated" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta"
  ) {
    return false
  }

  if (event.type === "session.next.created") {
    return linkChild(input.data, event.properties.info.parentID, event.properties.info.id, input.sessionID)
  }

  if (event.properties.sessionID === input.sessionID) {
    return reduceRootTask(input.data, event, input.sessionID)
  }

  const sessionID = event.properties.sessionID
  if (!knownSession(input.data, sessionID)) {
    return false
  }

  const detail = ensureDetail(input.data, sessionID)
  const cancelled =
    event.type === "session.next.step.failed" && event.properties.error.message === INTERRUPTED_STEP
      ? cancelSubagentTab(input.data, sessionID)
      : false

  if (event.type === "session.next.retried") {
    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: event.properties.error.message,
          phase: "start",
          source: "system",
          messageID: `retry:${event.properties.attempt}`,
        },
      ]) || cancelled
    )
  }

  if (event.type === "session.next.failed") {
    const text = failureText(event.properties)
    return (
      appendCommits(detail, [
        {
          kind: "error",
          text,
          phase: "start",
          source: "system",
          messageID: `session.failed:${sessionID}:${text}`,
        },
      ]) || cancelled
    )
  }

  return (
    applyChildEvent({
      detail,
      event,
      thinking: input.thinking,
      limits: input.limits,
    }) || cancelled
  )
}

// Tracks the root session's `task` calls so their tabs follow the call.
function reduceRootTask(data: SubagentData, event: SessionDataEvent, rootID: string) {
  if (event.type === "session.next.tool.called") {
    if (event.properties.tool !== "task") {
      return false
    }

    data.tasks.set(partKey(event.properties.assistantMessageID, event.properties.callID), {
      messageID: event.properties.assistantMessageID,
      callID: event.properties.callID,
      input: event.properties.input,
      created: event.properties.timestamp,
    })
    return false
  }

  if (event.type !== "session.next.tool.success" && event.type !== "session.next.tool.failed") {
    return false
  }

  const key = partKey(event.properties.assistantMessageID, event.properties.callID)
  const task = data.tasks.get(key)
  if (!task) {
    return false
  }

  data.tasks.delete(key)
  const reported = event.type === "session.next.tool.success" ? text(event.properties.structured.sessionID) : undefined
  const sessionID = reported ?? task.sessionID
  if (!sessionID) {
    return false
  }

  const part = liveToolPart(rootID, task.messageID, {
    type: "tool",
    id: task.callID,
    name: "task",
    state:
      event.type === "session.next.tool.success"
        ? {
            status: "completed",
            input: task.input,
            structured: event.properties.structured,
            content: [...event.properties.content],
          }
        : { status: "error", input: task.input, structured: {}, content: [], error: event.properties.error },
    time: { created: task.created, ran: task.created, completed: event.properties.timestamp },
  })
  return syncTaskTab(data, { ...part, metadata: { ...part.metadata, sessionId: sessionID } })
}

// Links a newly created child session to the oldest running task call that
// has none. `task` spawns its child while the call runs, in call order.
function linkChild(data: SubagentData, parentID: string | undefined, sessionID: string, rootID: string) {
  if (parentID !== rootID || data.tabs.has(sessionID)) {
    return false
  }

  const task = [...data.tasks.values()].find((item) => !item.sessionID)
  if (!task) {
    return false
  }

  task.sessionID = sessionID
  const part = liveToolPart(rootID, task.messageID, {
    type: "tool",
    id: task.callID,
    name: "task",
    state: { status: "running", input: task.input, structured: {}, content: [] },
    time: { created: task.created, ran: task.created },
  })
  return syncTaskTab(data, { ...part, metadata: { ...part.metadata, sessionId: sessionID } })
}
