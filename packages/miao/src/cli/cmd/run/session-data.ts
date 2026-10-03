// Core reducer for direct interactive mode.
//
// Takes V2 session events (and projected V1-shaped parts on replay) and
// produces two outputs:
//   - StreamCommit[]: append-only scrollback entries (text, tool, error, etc.)
//   - FooterOutput:   status bar patches and view transitions (permission, question)
//
// The reducer mutates SessionData in place for performance but has no
// external side effects -- no IO, no footer calls. The caller
// (stream.transport.ts) feeds events in and forwards output to the footer
// through stream.ts.
//
// Key design decisions:
//
// - Text parts buffer in `data.text` until their message role is confirmed as
//   "assistant". This prevents echoing user-role text parts. The `ready()`
//   check gates output: if we see a text delta before the step or message
//   update that tells us the role, we stash it and flush later via `replay()`.
//
// - Tool echo stripping: bash tools may echo their own output in the next
//   assistant text part. `stashEcho()` records completed bash output, and
//   `stripEcho()` removes it from the start of the next assistant chunk.
//
// - Permission and question requests queue in `data.permissions` and
//   `data.questions`. The footer shows whichever is first. When a reply
//   event arrives, the queue entry is removed and the footer falls back
//   to the next pending request or to the prompt view.
import type {
  Event,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionMessageAssistantTool,
  ToolPart,
} from "@miao/sdk/v2"
import * as Locale from "@/util/locale"
import { INTERRUPTED_STEP, liveToolPart, partKey, permissionRequest, questionRequest } from "./session-v2"
import { toolView } from "./tool"
import type { FooterOutput, FooterPatch, FooterView, StreamCommit } from "./types"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

// Projected message and part updates in the V1 shape (replay and the demo).
export type PartEvent = Extract<Event, { type: "message.updated" | "message.part.updated" | "message.part.delta" }>

// Published by the V2 runtime (`specs/v2/session.md`, "Status, Retry, and
// Failure Events") but not yet part of the generated SDK event union.
export type SessionStatusEvent = {
  id?: string
  type: "session.next.status"
  properties: { sessionID: string; timestamp: number; status: { type: "busy" | "idle" } }
}

export type SessionFailedEvent = {
  id?: string
  type: "session.next.failed"
  properties: { sessionID: string; timestamp: number; error: { type: "unknown"; message: string }; name?: string }
}

export type SessionV2Event =
  | Extract<Event, { type: `session.next.${string}` | `permission.v2.${string}` | `question.v2.${string}` }>
  | SessionStatusEvent
  | SessionFailedEvent

export type SessionDataEvent = SessionV2Event | PartEvent

type MessageView = {
  id: string
  role: MessageRole
  providerID?: string
  modelID?: string
  tokens?: Tokens
  cost?: number
  error?: { name?: string; message?: string; data?: { message?: string } }
}

// A V2 tool call between `tool.input.started`/`tool.called` and its
// settlement. Success and failure events carry neither the tool name nor its
// input, so they are kept here.
type ToolCall = {
  callID: string
  name: string
  created: number
  ran?: number
  input: Record<string, unknown>
  structured: Record<string, unknown>
}

type PartKind = "assistant" | "reasoning" | "user"
type MessageRole = "assistant" | "user"
type Dict = Record<string, unknown>
type SessionCommit = StreamCommit

// Mutable accumulator for the reducer. Each field tracks a different aspect
// of the stream so we can produce correct incremental output:
//
// - ids:    parts and error keys we've already committed (dedup guard)
// - tools:  tool parts we've emitted a "start" for but not yet completed
// - call:   tool call inputs, keyed by msg:call, for enriching permission views
// - role:   message ID → "assistant" | "user", learned from message.updated
// - msg:    part ID → message ID
// - part:   part ID → "assistant" | "reasoning" (text parts only)
// - text:   part ID → full accumulated text so far
// - sent:   part ID → byte offset of last flushed text (for incremental output)
// - visible: part ID → rendered text for an active part after display transforms
// - end:    part IDs whose time.end has arrived (part is finished)
// - shell:  shell call ID → chosen transcript source for direct shell calls
// - echo:   message ID → bash outputs to strip from the next assistant chunk
// - steps:  assistant message ID → model, learned from session.next.step.started
// - calls:  scoped tool part ID → in-flight V2 tool call
// - retrying: a retry notice is showing in the footer status
type ShellCall = {
  source: "shell" | "tool"
  command?: string
}

export type SessionData = {
  includeUserText: boolean
  announced: boolean
  ids: Set<string>
  tools: Set<string>
  call: Map<string, Dict>
  shell: Map<string, ShellCall>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  role: Map<string, MessageRole>
  msg: Map<string, string>
  part: Map<string, PartKind>
  text: Map<string, string>
  sent: Map<string, number>
  visible: Map<string, string>
  end: Set<string>
  echo: Map<string, Set<string>>
  steps: Map<string, { providerID: string; modelID: string }>
  calls: Map<string, ToolCall>
  retrying: boolean
}

export type SessionDataInput = {
  data: SessionData
  event: SessionDataEvent
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}

export type SessionDataOutput = {
  data: SessionData
  commits: SessionCommit[]
  footer?: FooterOutput
}

export function createSessionData(
  input: {
    includeUserText?: boolean
  } = {},
): SessionData {
  return {
    includeUserText: input.includeUserText ?? false,
    announced: false,
    ids: new Set(),
    tools: new Set(),
    call: new Map(),
    shell: new Map(),
    permissions: [],
    questions: [],
    role: new Map(),
    msg: new Map(),
    part: new Map(),
    text: new Map(),
    sent: new Map(),
    visible: new Map(),
    end: new Set(),
    echo: new Map(),
    steps: new Map(),
    calls: new Map(),
    retrying: false,
  }
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function formatUsage(
  tokens: Tokens | undefined,
  limit: number | undefined,
  cost: number | undefined,
): string | undefined {
  const total =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)

  if (total <= 0) {
    if (typeof cost === "number" && cost > 0) {
      return money.format(cost)
    }
    return undefined
  }

  const text =
    limit && limit > 0 ? `${Locale.number(total)} (${Math.round((total / limit) * 100)}%)` : Locale.number(total)

  if (typeof cost === "number" && cost > 0) {
    return `${text} · ${money.format(cost)}`
  }

  return text
}

export function formatError(error: {
  name?: string
  message?: string
  data?: {
    message?: string
  }
}): string {
  if (error.data?.message) {
    return error.data.message
  }

  if (error.message) {
    return error.message
  }

  if (error.name) {
    return error.name
  }

  return "unknown error"
}

function isAbort(error: { name?: string } | undefined): boolean {
  return error?.name === "MessageAbortedError"
}

function msgErr(id: string): string {
  return `msg:${id}:error`
}

function patch(patch?: FooterPatch, view?: FooterView): FooterOutput | undefined {
  if (!patch && !view) {
    return undefined
  }

  return {
    patch,
    view,
  }
}

function out(data: SessionData, commits: SessionCommit[], footer?: FooterOutput): SessionDataOutput {
  if (!footer) {
    return {
      data,
      commits,
    }
  }

  return {
    data,
    commits,
    footer,
  }
}

export function pickBlockerView(input: { permission?: PermissionRequest; question?: QuestionRequest }): FooterView {
  if (input.permission) {
    return { type: "permission", request: input.permission }
  }

  if (input.question) {
    return { type: "question", request: input.question }
  }

  return { type: "prompt" }
}

export function blockerStatus(view: FooterView) {
  if (view.type === "permission") {
    return "awaiting permission"
  }

  if (view.type === "question") {
    return "awaiting answer"
  }

  return ""
}

function pickSessionView(data: SessionData): FooterView {
  return pickBlockerView({
    permission: data.permissions[0],
    question: data.questions[0],
  })
}

function queueFooter(data: SessionData): FooterOutput {
  const view = pickSessionView(data)

  return {
    view,
    patch: { status: blockerStatus(view) },
  }
}

function queueOut(data: SessionData, commits: SessionCommit[]): SessionDataOutput {
  return out(data, commits, queueFooter(data))
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const idx = list.findIndex((entry) => entry.id === item.id)
  if (idx === -1) {
    list.push(item)
    return
  }

  list[idx] = item
}

function remove(list: Array<{ id: string }>, id: string): boolean {
  const idx = list.findIndex((entry) => entry.id === id)
  if (idx === -1) {
    return false
  }

  list.splice(idx, 1)
  return true
}

export function bootstrapSessionData(input: {
  data: SessionData
  messages: Array<{
    parts: Part[]
  }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}) {
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      input.data.call.set(key(part.messageID, part.callID), part.state.input)
    }
  }

  for (const request of input.permissions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    upsert(input.data.permissions, enrichPermission(input.data, request))
  }

  for (const request of input.questions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    upsert(input.data.questions, request)
  }
}

function key(msg: string, call: string): string {
  return `${msg}:${call}`
}

function enrichPermission(data: SessionData, request: PermissionRequest): PermissionRequest {
  if (!request.tool) {
    return request
  }

  const input = data.call.get(key(request.tool.messageID, request.tool.callID))
  if (!input) {
    return request
  }

  const meta = request.metadata ?? {}
  if (meta.input === input) {
    return request
  }

  return {
    ...request,
    metadata: {
      ...meta,
      input,
    },
  }
}

// Updates the active permission request when the matching tool part gets
// new input (e.g., a diff). This keeps the permission UI in sync with the
// tool's evolving state. Only triggers a footer update if the currently
// displayed permission was the one that changed.
function syncPermission(data: SessionData, part: ToolPart): FooterOutput | undefined {
  data.call.set(key(part.messageID, part.callID), part.state.input)
  if (data.permissions.length === 0) {
    return undefined
  }

  let changed = false
  let active = false
  data.permissions = data.permissions.map((request, index) => {
    if (!request.tool || request.tool.messageID !== part.messageID || request.tool.callID !== part.callID) {
      return request
    }

    const next = enrichPermission(data, request)
    if (next === request) {
      return request
    }

    changed = true
    active ||= index === 0
    return next
  })

  if (!changed || !active) {
    return undefined
  }

  return {
    view: pickSessionView(data),
  }
}

// Question tool replies can complete without a matching question.replied event.
// When that happens, drop the recovered pending request tied to this tool call so
// the footer can return to the next blocker or to the prompt.
function syncQuestion(data: SessionData, part: ToolPart): FooterOutput | undefined {
  if (part.tool !== "question") {
    return undefined
  }

  if (part.state.status !== "completed" && part.state.status !== "error") {
    return undefined
  }

  const next = data.questions.filter(
    (request) => request.tool?.messageID !== part.messageID || request.tool?.callID !== part.callID,
  )
  if (next.length === data.questions.length) {
    return undefined
  }

  data.questions = next
  return queueFooter(data)
}

function toolStatus(part: ToolPart): string {
  if (part.tool !== "task") {
    return `running ${part.tool}`
  }

  const state = part.state as {
    input?: {
      description?: unknown
      subagent_type?: unknown
    }
  }
  const desc = state.input?.description
  if (typeof desc === "string" && desc.trim()) {
    return `running ${desc.trim()}`
  }

  const type = state.input?.subagent_type
  if (typeof type === "string" && type.trim()) {
    return `running ${type.trim()}`
  }

  return "running task"
}

// Returns true if we can flush this part's text to scrollback.
//
// We gate on the message role being "assistant" because user-role messages
// also contain text parts (the user's own input) which we don't want to
// echo. If we haven't received the message.updated event yet, we return
// false and the text stays buffered until replay() flushes it.
function ready(data: SessionData, partID: string): boolean {
  const msg = data.msg.get(partID)
  if (!msg) {
    return true
  }

  const role = data.role.get(msg)
  if (!role) {
    return false
  }

  if (role === "assistant") {
    return true
  }

  return data.includeUserText && role === "user"
}

function syncText(data: SessionData, partID: string, next: string) {
  const prev = data.text.get(partID) ?? ""
  if (!next) {
    return prev
  }

  if (!prev || next.length >= prev.length) {
    data.text.set(partID, next)
    return next
  }

  return prev
}

// Records bash tool output for echo stripping. Some models echo bash output
// verbatim at the start of their next text part. We save both the raw and
// trimmed forms so stripEcho() can match either.
function stashEcho(data: SessionData, part: ToolPart) {
  if (part.tool !== "bash") {
    return
  }

  if (typeof part.messageID !== "string" || !part.messageID) {
    return
  }

  const output = "output" in part.state ? part.state.output : undefined
  if (typeof output !== "string") {
    return
  }

  const text = output.replace(/^\n+/, "")
  if (!text.trim()) {
    return
  }

  const set = data.echo.get(part.messageID) ?? new Set<string>()
  set.add(text)
  const trim = text.replace(/\n+$/, "")
  if (trim && trim !== text) {
    set.add(trim)
  }
  data.echo.set(part.messageID, set)
}

function stripEcho(data: SessionData, msg: string | undefined, chunk: string): string {
  if (!msg) {
    return chunk
  }

  const set = data.echo.get(msg)
  if (!set || set.size === 0) {
    return chunk
  }

  data.echo.delete(msg)
  const list = [...set].sort((a, b) => b.length - a.length)
  for (const item of list) {
    if (!item || !chunk.startsWith(item)) {
      continue
    }

    return chunk.slice(item.length).replace(/^\n+/, "")
  }

  return chunk
}

function flushPart(data: SessionData, commits: SessionCommit[], partID: string, interrupted = false) {
  const kind = data.part.get(partID)
  if (!kind) {
    return
  }

  const text = data.text.get(partID) ?? ""
  const sent = data.sent.get(partID) ?? 0
  let chunk = text.slice(sent)
  const msg = data.msg.get(partID)

  if (sent === 0) {
    chunk = chunk.replace(/^\n+/, "")
    // Some models emit a standalone whitespace token before real content.
    // Keep buffering until we have visible text so scrollback doesn't get a blank row.
    if (!chunk.trim()) {
      return
    }
    if (kind === "reasoning" && chunk) {
      chunk = `Thinking: ${chunk.replace(/\[REDACTED\]/g, "")}`
    }
    if (kind === "assistant" && chunk) {
      chunk = stripEcho(data, msg, chunk)
      if (!chunk.trim()) {
        return
      }
    }
  }

  if (chunk) {
    data.sent.set(partID, text.length)
    data.visible.set(partID, (data.visible.get(partID) ?? "") + chunk)
    commits.push({
      kind,
      text: chunk,
      phase: "progress",
      source: kind === "user" ? "system" : kind,
      messageID: msg,
      partID,
    })
  }

  if (!interrupted) {
    return
  }

  commits.push({
    kind,
    text: "",
    phase: "final",
    source: kind === "user" ? "system" : kind,
    messageID: msg,
    partID,
    interrupted: true,
  })
}

function drop(data: SessionData, partID: string) {
  data.part.delete(partID)
  data.text.delete(partID)
  data.sent.delete(partID)
  data.visible.delete(partID)
  data.msg.delete(partID)
  data.end.delete(partID)
}

// Called when we learn a message's role (from message.updated). Flushes any
// buffered text parts that were waiting on role confirmation. User-role
// parts are silently dropped.
function replay(data: SessionData, commits: SessionCommit[], messageID: string, role: MessageRole, thinking: boolean) {
  for (const [partID, msg] of data.msg.entries()) {
    if (msg !== messageID || data.ids.has(partID)) {
      continue
    }

    if (role === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    const kind = data.part.get(partID)
    if (!kind) {
      continue
    }

    if (role === "user" && kind === "assistant") {
      data.part.set(partID, "user")
    }

    if (kind === "reasoning" && !thinking) {
      if (data.end.has(partID)) {
        data.ids.add(partID)
      }
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID)

    if (!data.end.has(partID)) {
      continue
    }

    data.ids.add(partID)
    drop(data, partID)
  }
}

function toolCommit(
  part: ToolPart,
  next: Pick<SessionCommit, "text" | "phase" | "toolState"> & { toolError?: string },
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    messageID: part.messageID,
    partID: part.id,
    tool: part.tool,
    part,
    ...next,
  }
}

function shellPartID(callID: string): string {
  return `shell:${callID}`
}

function claimShell(data: SessionData, callID: string, source: ShellCall["source"], command?: string): ShellCall {
  const current = data.shell.get(callID)
  if (current) {
    if (command && !current.command) {
      current.command = command
    }

    return current
  }

  const next = {
    source,
    ...(command ? { command } : {}),
  } satisfies ShellCall
  data.shell.set(callID, next)
  return next
}

function bashCommand(part: ToolPart): string | undefined {
  if (part.tool !== "bash") {
    return undefined
  }

  const input = part.state.input
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }

  const command = Reflect.get(input, "command")
  return typeof command === "string" ? command : undefined
}

function shellCommit(
  input: {
    callID: string
    command: string
  },
  next: Pick<SessionCommit, "text" | "phase" | "toolState">,
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: shellPartID(input.callID),
    tool: "bash",
    shell: input,
    ...next,
  }
}

function startShell(callID: string, command: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: "running shell",
      phase: "start",
      toolState: "running",
    },
  )
}

function doneShell(callID: string, command: string, output: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: output,
      phase: "progress",
      toolState: "completed",
    },
  )
}

function startTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: toolStatus(part),
    phase: "start",
    toolState: "running",
  })
}

function doneTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: "",
    phase: "final",
    toolState: "completed",
  })
}

function failTool(part: ToolPart, text: string): SessionCommit {
  return toolCommit(part, {
    text,
    phase: "final",
    toolState: "error",
    toolError: text,
  })
}

// Emits "interrupted" final entries for all in-flight parts. Called when a turn is aborted.
export function flushInterrupted(data: SessionData, commits: SessionCommit[]) {
  for (const partID of data.part.keys()) {
    if (data.ids.has(partID)) {
      continue
    }

    const msg = data.msg.get(partID)
    if (msg && data.role.get(msg) === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID, true)
    data.ids.add(partID)
    drop(data, partID)
  }
}

// Applies what is known about a message: its role (which releases or drops
// buffered text), and for assistant messages the usage and any error.
function applyMessage(
  data: SessionData,
  commits: SessionCommit[],
  info: MessageView,
  input: Pick<SessionDataInput, "thinking" | "limits">,
): FooterPatch | undefined {
  data.role.set(info.id, info.role)
  replay(data, commits, info.id, info.role, input.thinking)
  if (info.role !== "assistant") {
    return undefined
  }

  let next: FooterPatch | undefined
  if (!data.announced) {
    data.announced = true
    next = { status: "assistant responding" }
  }

  const usage = formatUsage(
    info.tokens,
    input.limits[modelKey(info.providerID ?? "", info.modelID ?? "")],
    typeof info.cost === "number" ? info.cost : undefined,
  )
  if (usage) {
    next = {
      ...next,
      usage,
    }
  }

  if (info.error && !isAbort(info.error) && !data.ids.has(msgErr(info.id))) {
    data.ids.add(msgErr(info.id))
    commits.push({
      kind: "error",
      text: formatError(info.error),
      phase: "start",
      source: "system",
      messageID: info.id,
    })
  }

  return next
}

function applyDelta(
  data: SessionData,
  commits: SessionCommit[],
  delta: { messageID?: string; partID: string; text: string },
  thinking: boolean,
) {
  if (data.ids.has(delta.partID)) {
    return
  }

  if (delta.messageID) {
    data.msg.set(delta.partID, delta.messageID)
  }

  data.text.set(delta.partID, (data.text.get(delta.partID) ?? "") + delta.text)

  const kind = data.part.get(delta.partID)
  if (!kind) {
    return
  }

  if (kind === "reasoning" && !thinking) {
    return
  }

  if (!ready(data, delta.partID)) {
    return
  }

  flushPart(data, commits, delta.partID)
}

function applyTool(data: SessionData, commits: SessionCommit[], part: ToolPart): FooterOutput | undefined {
  const view = syncPermission(data, part) ?? syncQuestion(data, part)
  if (part.tool === "bash" && part.callID) {
    if (claimShell(data, part.callID, "tool", bashCommand(part)).source === "shell") {
      return view
    }
  }

  if (part.state.status === "running") {
    if (data.ids.has(part.id)) {
      return view
    }

    if (!data.tools.has(part.id)) {
      data.tools.add(part.id)
      commits.push(startTool(part))
    }

    return view ?? patch({ status: toolStatus(part) })
  }

  if (part.state.status === "completed") {
    const seen = data.tools.has(part.id)
    const mode = toolView(part.tool)
    data.tools.delete(part.id)
    if (data.ids.has(part.id)) {
      return view
    }

    if (!seen) {
      commits.push(startTool(part))
    }

    data.ids.add(part.id)
    stashEcho(data, part)

    const output = part.state.output
    if (mode.output && typeof output === "string" && output.trim()) {
      commits.push({
        kind: "tool",
        text: output,
        phase: "progress",
        source: "tool",
        messageID: part.messageID,
        partID: part.id,
        tool: part.tool,
        part,
        toolState: "completed",
      })
    }

    if (mode.final) {
      commits.push(doneTool(part))
    }

    return view
  }

  if (part.state.status === "error") {
    const seen = data.tools.has(part.id)
    data.tools.delete(part.id)
    if (data.ids.has(part.id)) {
      return view
    }

    if (!seen) {
      commits.push(startTool(part))
    }

    data.ids.add(part.id)
    const text = typeof part.state.error === "string" && part.state.error.trim() ? part.state.error : "unknown error"
    commits.push(failTool(part, text))
    return view
  }

  return view
}

function applyPart(
  data: SessionData,
  commits: SessionCommit[],
  part: Part,
  thinking: boolean,
): FooterOutput | undefined {
  if (part.type === "tool") {
    return applyTool(data, commits, part)
  }

  if (part.type !== "text" && part.type !== "reasoning") {
    return undefined
  }

  if (data.ids.has(part.id)) {
    return undefined
  }

  const kind = part.type === "text" ? "assistant" : "reasoning"
  if (typeof part.messageID === "string") {
    data.msg.set(part.id, part.messageID)
  }

  const msg = part.messageID
  const role = msg ? data.role.get(msg) : undefined
  if (role === "user" && part.type === "text" && !data.includeUserText) {
    data.ids.add(part.id)
    drop(data, part.id)
    return undefined
  }

  if (kind === "reasoning" && !thinking) {
    if (part.time?.end) {
      data.ids.add(part.id)
    }
    drop(data, part.id)
    return undefined
  }

  data.part.set(part.id, role === "user" && kind === "assistant" ? "user" : kind)
  syncText(data, part.id, part.text)

  if (part.time?.end) {
    data.end.add(part.id)
  }

  if (msg && !role) {
    return undefined
  }

  if (!ready(data, part.id)) {
    return undefined
  }

  flushPart(data, commits, part.id)

  if (!part.time?.end) {
    return undefined
  }

  data.ids.add(part.id)
  drop(data, part.id)
  return undefined
}

// Projected message and part updates, in the V1 shape. Replay feeds the V2
// transcript through these after `session-v2.ts` maps it, and the demo drives
// them directly.
function reducePartEvent(input: SessionDataInput & { event: PartEvent }): SessionDataOutput {
  const commits: SessionCommit[] = []
  const data = input.data
  const event = input.event

  if (event.type === "message.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const info = event.properties.info
    const next = applyMessage(
      data,
      commits,
      info.role === "assistant"
        ? {
            id: info.id,
            role: "assistant",
            providerID: info.providerID,
            modelID: info.modelID,
            tokens: info.tokens,
            cost: info.cost,
            error: info.error,
          }
        : { id: info.id, role: info.role },
      input,
    )
    return out(data, commits, patch(next))
  }

  if (event.type === "message.part.delta") {
    if (event.properties.sessionID !== input.sessionID || event.properties.field !== "text") {
      return out(data, commits)
    }

    applyDelta(
      data,
      commits,
      { messageID: event.properties.messageID, partID: event.properties.partID, text: event.properties.delta },
      input.thinking,
    )
    return out(data, commits)
  }

  const part = event.properties.part
  if (part.sessionID !== input.sessionID) {
    return out(data, commits)
  }

  return out(data, commits, applyPart(data, commits, part, input.thinking))
}

// Tag of the drain failure for a session whose history was never migrated.
const LEGACY_NOT_MIGRATED = "Session.LegacyNotMigratedError"

export function failureText(input: { error: { message: string }; name?: string }) {
  if (input.name === LEGACY_NOT_MIGRATED) {
    return `${input.error.message}\nRun \`miao db backfill\` to migrate this session's history.`
  }

  return input.error.message || input.name || "unknown error"
}

// A retry notice belongs to the open turn and is cleared by the next step,
// text, or failure for the session.
function settleRetry(data: SessionData, next: FooterPatch | undefined): FooterPatch | undefined {
  if (!data.retrying) {
    return next
  }

  data.retrying = false
  return { status: "assistant responding", ...next }
}

// Every text, reasoning, and tool event belongs to an assistant message; when
// the stream is joined mid-step its `step.started` was missed, so learn the
// role from the event itself.
function assistantRole(data: SessionData, commits: SessionCommit[], messageID: string, thinking: boolean) {
  if (data.role.has(messageID)) {
    return
  }

  data.role.set(messageID, "assistant")
  replay(data, commits, messageID, "assistant", thinking)
}

function streamPart(
  sessionID: string,
  event: { assistantMessageID: string; timestamp: number },
  id: string,
  type: "text" | "reasoning",
  text: string,
  end?: number,
): Part {
  const time = { start: event.timestamp, ...(end === undefined ? {} : { end }) }
  return {
    id: partKey(event.assistantMessageID, id),
    sessionID,
    messageID: event.assistantMessageID,
    type,
    text,
    time,
  }
}

function callTool(
  sessionID: string,
  messageID: string,
  call: ToolCall,
  state: SessionMessageAssistantTool["state"],
  completed?: number,
): ToolPart {
  return liveToolPart(sessionID, messageID, {
    type: "tool",
    id: call.callID,
    name: call.name,
    state,
    time: { created: call.created, ran: call.ran, ...(completed === undefined ? {} : { completed }) },
  })
}

function reduceV2Event(input: SessionDataInput & { event: SessionV2Event }): SessionDataOutput {
  const commits: SessionCommit[] = []
  const data = input.data
  const event = input.event

  if (event.properties.sessionID !== input.sessionID) {
    return out(data, commits)
  }

  switch (event.type) {
    case "session.next.shell.started": {
      const shell = claimShell(data, event.properties.callID, "shell", event.properties.command)
      if (shell.source !== "shell") {
        return out(data, commits)
      }

      const partID = shellPartID(event.properties.callID)
      if (data.ids.has(partID) || data.tools.has(partID)) {
        return out(data, commits, patch({ status: "running shell" }))
      }

      data.tools.add(partID)
      commits.push(startShell(event.properties.callID, shell.command ?? event.properties.command))
      return out(data, commits, patch({ status: "running shell" }))
    }

    case "session.next.shell.ended": {
      const shell = claimShell(data, event.properties.callID, "shell")
      if (shell.source !== "shell") {
        return out(data, commits)
      }

      const partID = shellPartID(event.properties.callID)
      const seen = data.tools.has(partID)
      const command = shell.command ?? ""
      data.tools.delete(partID)
      if (data.ids.has(partID)) {
        return out(data, commits)
      }

      if (!seen && command) {
        commits.push(startShell(event.properties.callID, command))
      }

      data.ids.add(partID)
      commits.push(doneShell(event.properties.callID, command, event.properties.output))
      return out(data, commits)
    }

    // Only the subagent inspector shows user text; the root transcript echoes
    // prompts locally when they are sent.
    case "session.next.prompted": {
      if (!data.includeUserText || !event.properties.prompt.text.trim()) {
        return out(data, commits)
      }

      const prompt = event.properties
      applyMessage(data, commits, { id: prompt.messageID, role: "user" }, input)
      const part: Part = {
        id: `${prompt.messageID}-text`,
        sessionID: input.sessionID,
        messageID: prompt.messageID,
        type: "text",
        text: prompt.prompt.text,
        time: { start: prompt.timestamp, end: prompt.timestamp },
      }
      return out(data, commits, applyPart(data, commits, part, input.thinking))
    }

    case "session.next.step.started": {
      const step = event.properties
      data.steps.set(step.assistantMessageID, { providerID: step.model.providerID, modelID: step.model.id })
      const next = applyMessage(
        data,
        commits,
        { id: step.assistantMessageID, role: "assistant", providerID: step.model.providerID, modelID: step.model.id },
        input,
      )
      return out(data, commits, patch(settleRetry(data, next)))
    }

    case "session.next.step.ended": {
      const step = event.properties
      const model = data.steps.get(step.assistantMessageID)
      const next = applyMessage(
        data,
        commits,
        {
          id: step.assistantMessageID,
          role: "assistant",
          providerID: model?.providerID,
          modelID: model?.modelID,
          tokens: step.tokens,
          cost: step.cost,
        },
        input,
      )
      return out(data, commits, patch(next))
    }

    case "session.next.step.failed": {
      const step = event.properties
      const next = applyMessage(
        data,
        commits,
        {
          id: step.assistantMessageID,
          role: "assistant",
          error: {
            name: step.error.message === INTERRUPTED_STEP ? "MessageAbortedError" : "UnknownError",
            message: step.error.message,
          },
        },
        input,
      )
      return out(data, commits, patch(settleRetry(data, next)))
    }

    case "session.next.text.started":
    case "session.next.reasoning.started": {
      const item = event.properties
      const id = event.type === "session.next.text.started" ? event.properties.textID : event.properties.reasoningID
      assistantRole(data, commits, item.assistantMessageID, input.thinking)
      const type = event.type === "session.next.text.started" ? "text" : "reasoning"
      const next = applyPart(data, commits, streamPart(input.sessionID, item, id, type, ""), input.thinking)
      return out(data, commits, type === "text" ? merge(next, settleRetry(data, undefined)) : next)
    }

    case "session.next.text.delta":
    case "session.next.reasoning.delta": {
      const item = event.properties
      const id = event.type === "session.next.text.delta" ? event.properties.textID : event.properties.reasoningID
      assistantRole(data, commits, item.assistantMessageID, input.thinking)
      applyDelta(
        data,
        commits,
        { messageID: item.assistantMessageID, partID: partKey(item.assistantMessageID, id), text: item.delta },
        input.thinking,
      )
      return out(data, commits)
    }

    case "session.next.text.ended":
    case "session.next.reasoning.ended": {
      const item = event.properties
      const id = event.type === "session.next.text.ended" ? event.properties.textID : event.properties.reasoningID
      const type = event.type === "session.next.text.ended" ? "text" : "reasoning"
      assistantRole(data, commits, item.assistantMessageID, input.thinking)
      const part = streamPart(input.sessionID, item, id, type, item.text, item.timestamp)
      const next = applyPart(data, commits, part, input.thinking)
      return out(data, commits, type === "text" ? merge(next, settleRetry(data, undefined)) : next)
    }

    case "session.next.tool.input.started": {
      const item = event.properties
      data.calls.set(partKey(item.assistantMessageID, item.callID), {
        callID: item.callID,
        name: item.name,
        created: item.timestamp,
        input: {},
        structured: {},
      })
      return out(data, commits)
    }

    case "session.next.tool.called": {
      const item = event.properties
      const key = partKey(item.assistantMessageID, item.callID)
      assistantRole(data, commits, item.assistantMessageID, input.thinking)
      const call = {
        callID: item.callID,
        name: item.tool,
        created: data.calls.get(key)?.created ?? item.timestamp,
        ran: item.timestamp,
        input: item.input,
        structured: {},
      }
      data.calls.set(key, call)
      const part = callTool(input.sessionID, item.assistantMessageID, call, {
        status: "running",
        input: item.input,
        structured: {},
        content: [],
      })
      return out(data, commits, applyTool(data, commits, part))
    }

    case "session.next.tool.progress": {
      const item = event.properties
      const call = data.calls.get(partKey(item.assistantMessageID, item.callID))
      if (call) {
        call.structured = item.structured
      }
      return out(data, commits)
    }

    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const item = event.properties
      const key = partKey(item.assistantMessageID, item.callID)
      assistantRole(data, commits, item.assistantMessageID, input.thinking)
      // A call that started before this stream was joined has no recorded
      // name or input; render it generically rather than dropping it.
      const call = data.calls.get(key) ?? {
        callID: item.callID,
        name: "tool",
        created: item.timestamp,
        input: {},
        structured: {},
      }
      data.calls.delete(key)
      const part = callTool(
        input.sessionID,
        item.assistantMessageID,
        call,
        event.type === "session.next.tool.success"
          ? {
              status: "completed",
              input: call.input,
              structured: event.properties.structured,
              content: [...event.properties.content],
            }
          : {
              status: "error",
              input: call.input,
              structured: call.structured,
              content: [],
              error: event.properties.error,
            },
        item.timestamp,
      )
      return out(data, commits, applyTool(data, commits, part))
    }

    case "session.next.retried": {
      data.retrying = true
      const item = event.properties
      return out(data, commits, patch({ status: `retrying (attempt ${item.attempt}): ${item.error.message}` }))
    }

    case "session.next.failed": {
      commits.push({
        kind: "error",
        text: failureText(event.properties),
        phase: "start",
        source: "system",
      })
      return out(data, commits, patch(settleRetry(data, undefined)))
    }

    case "session.next.compaction.started": {
      return out(data, commits, patch({ status: "compacting context" }))
    }

    case "session.next.compaction.ended": {
      commits.push(compactionCommit(event.properties.messageID, event.properties.reason))
      return out(data, commits)
    }

    case "permission.v2.asked": {
      upsert(data.permissions, enrichPermission(data, permissionRequest(event.properties)))
      return queueOut(data, commits)
    }

    case "permission.v2.replied": {
      if (!remove(data.permissions, event.properties.requestID)) {
        return out(data, commits)
      }

      return queueOut(data, commits)
    }

    case "question.v2.asked": {
      upsert(data.questions, questionRequest(event.properties))
      return queueOut(data, commits)
    }

    case "question.v2.replied":
    case "question.v2.rejected": {
      if (!remove(data.questions, event.properties.requestID)) {
        return out(data, commits)
      }

      return queueOut(data, commits)
    }
  }

  return out(data, commits)
}

function merge(left: FooterOutput | undefined, next: FooterPatch | undefined): FooterOutput | undefined {
  if (!next) {
    return left
  }

  return { ...left, patch: { ...left?.patch, ...next } }
}

export function compactionCommit(messageID: string, reason: "auto" | "manual"): SessionCommit {
  return {
    kind: "system",
    text: `context compacted (${reason})`,
    phase: "final",
    source: "system",
    messageID,
  }
}

// The main reducer. Takes one event and returns scrollback commits and footer
// updates. Called once per event from the stream transport's watch loop.
//
// Live events are the V2 session vocabulary:
//   session.next.step.*        → learn the assistant message, track usage, errors
//   session.next.text/reasoning.* → accumulate and flush text
//   session.next.tool.*        → tool start/finish entries
//   session.next.shell.*       → direct shell mode entries
//   session.next.retried/failed/compaction.* → status and error entries
//   permission.v2.* / question.v2.* → blocker queues, footer view
// Projected V1-shaped message/part updates come from replay and the demo.
export function reduceSessionData(input: SessionDataInput): SessionDataOutput {
  const event = input.event
  if (
    event.type === "message.updated" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta"
  ) {
    return reducePartEvent({ ...input, event })
  }

  return reduceV2Event({ ...input, event })
}
