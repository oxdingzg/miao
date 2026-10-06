// Non-interactive `miao run` on the V2 session API.
//
// V2 streams `session.next.*` events rather than V1 message/part updates, and a
// V2 prompt carries only its text. This sends the prompt, mirrors the session's
// projected transcript to stdout as it settles (in the same V1 part shapes the
// `--format json` output has always used), answers permission and question asks
// that a headless run cannot put to a person, and returns once the session's
// agent loop goes idle.
import type { Part, SessionMessage, ToolPart } from "@miao/schema/view-models"
import { type Client } from "@/client"
import { mutableResponse } from "@miao/tui/util/mutable-response"
import { isV2StreamFragmentEvent } from "@miao/tui/context/session-v2"
import { promptInputFromParts, sessionContextToMessages, toolPart } from "@miao/tui/context/session-v2-write"

export type HeadlessInput = {
  client: Client
  sessionID: string
  directory: string
  agent: string | undefined
  model: { providerID: string; modelID: string } | undefined
  variant: string | undefined
  message: string
  files: ReadonlyArray<{ type: "file"; url: string; filename?: string }>
  command: string | undefined
  thinking: boolean
  /** `--format json`: every settled part is written as one JSON event instead of printed. */
  json: boolean
  /** Approve permission asks instead of rejecting them. */
  auto: boolean
  /** Writes one `--format json` event; returns false when the output is human-readable. */
  emit: (type: string, data: Record<string, unknown>) => boolean
  print: {
    header: (agent: string, modelID: string) => void
    tool: (part: ToolPart) => Promise<void>
    toolError: (part: ToolPart) => Promise<void>
    text: (text: string) => void
    reasoning: (text: string) => void
    warning: (text: string) => void
    error: (text: string) => void
  }
}

/** Runs one prompt (or command) and resolves with the error text, if the run failed. */
export async function runHeadless(input: HeadlessInput): Promise<string | undefined> {
  const { client, sessionID } = input
  const sessions = new Set([sessionID])
  const seen = new Set<string>()
  const before = new Set((await context(client, sessionID)).map((message) => message.id))
  const errors: string[] = []
  let started = false

  // V1 refused an unknown model when the prompt was sent; V2 accepts any model
  // and fails the turn only after the catalog retry window, so check it first.
  const missing = await missingModel(input)
  if (missing) {
    const error = { name: "ModelNotFoundError", data: { message: missing } }
    errors.push(missing)
    if (!input.emit("error", { error })) input.print.error(missing)
    return missing
  }

  const abort = new AbortController()
  // The signal cancels the SSE read on shutdown. Without it the pending next()
  // keeps the generator busy, so iterator.return() waits for the next server
  // event — up to a heartbeat interval when the session has gone quiet.
  const events = client.events.subscribe({ signal: abort.signal })
  const watching = watch().catch((error: unknown) => {
    if (!abort.signal.aborted) report(errorText(error), error)
  })

  const interrupt = () => {
    void client.sessions
      .execution({ sessionID }, { signal: AbortSignal.timeout(3000) })
      .then((execution) =>
        execution.type === "running"
          ? client.sessions.interruptIf(
              { sessionID, executionID: execution.executionID },
              { signal: AbortSignal.timeout(3000) },
            )
          : undefined,
      )
      .catch(() => undefined)
      .finally(() => {
        process.exitCode = 130
        errors.push("Interrupted")
        abort.abort()
      })
  }
  process.once("SIGINT", interrupt)
  try {
    const error = await applySelection(input)
      .then(async () => {
        if (input.command) {
          await client.sessions.command({ sessionID, command: input.command, arguments: input.message })
          return
        }
        await client.sessions.prompt({
          sessionID,
          prompt: promptInputFromParts([...input.files, { type: "text", text: input.message }]),
        })
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    if (error) {
      abort.abort()
      await watching
      return report(errorText(error), error)
    }

    await waitIdle()
    abort.abort()
    await watching
    // The session is idle: whatever text it produced is final even when the
    // stream never marked its message complete (an unknown finish does that).
    await mirror(true)
    return errors.length > 0 ? errors.join("\n") : undefined
  } finally {
    process.off("SIGINT", interrupt)
    abort.abort()
    await watching
  }

  async function watch() {
    const iterator = events[Symbol.asyncIterator]()
    const stopped = new Promise<IteratorResult<unknown>>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve({ done: true, value: undefined })),
    )
    while (true) {
      const next = await Promise.race([iterator.next(), stopped])
      if (next.done) break
      const event = asEvent(next.value)
      if (!event) continue
      if (event.type === "session.next.created") {
        const parentID = field(field(event.properties, "info"), "parentID")
        const id = field(field(event.properties, "info"), "id")
        if (typeof parentID === "string" && sessions.has(parentID) && typeof id === "string") sessions.add(id)
        continue
      }
      if (event.type === "permission.v2.asked") {
        await answerPermission(event.properties)
        continue
      }
      if (event.type === "question.v2.asked") {
        await rejectQuestion(event.properties)
        continue
      }
      if (!event.type.startsWith("session.next.") || isV2StreamFragmentEvent(event.type)) continue
      if (field(event.properties, "sessionID") !== sessionID) continue
      await mirror()
    }
    await iterator.return?.()
  }

  // Durable state, not the event stream, is the source of truth: each settled
  // event re-reads the projected transcript and prints what has not been printed.
  async function mirror(final = false) {
    const messages = sessionContextToMessages({
      sessionID,
      cwd: input.directory,
      root: input.directory,
      messages: (await context(client, sessionID)).filter((message) => !before.has(message.id)),
    })
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      const info = message.info
      if (!started && !input.json) input.print.header(info.agent ?? "", info.modelID ?? "")
      started = true
      if (once(`${info.id}:start`)) input.emit("step_start", { part: stepStart(info.id) })
      const completed = info.time.completed !== undefined
      for (const [index, part] of message.parts.entries()) {
        // A text or reasoning part is final once anything follows it or the
        // assistant message has completed.
        const settled = final || completed || index < message.parts.length - 1
        await printPart(part, settled)
      }
      if (!completed) continue
      if (info.error && once(`${info.id}:error`)) report(errorText(info.error), info.error)
      if (once(`${info.id}:finish`)) input.emit("step_finish", { part: stepFinish(info) })
    }
  }

  // Part ids come from the provider stream and are only unique within one
  // message (AI SDK text parts restart at "text-0" every turn), so dedupe keys
  // are scoped by message id.
  async function printPart(part: Part, settled: boolean) {
    if (part.type === "tool") {
      if (part.state.status === "completed" || part.state.status === "error") {
        if (!once(`${part.messageID}:${part.id}:done`)) return
        if (input.emit("tool_use", { part })) return
        if (part.state.status === "completed") return input.print.tool(part)
        await input.print.toolError(part)
        return input.print.error(part.state.error)
      }
      if (
        part.tool === "task" &&
        part.state.status === "running" &&
        !input.json &&
        once(`${part.messageID}:${part.id}:running`)
      )
        await input.print.tool(part)
      return
    }
    if (!settled) return
    if (part.type === "text") {
      if (!once(`${part.messageID}:${part.id}`)) return
      if (input.emit("text", { part })) return
      if (part.text.trim()) input.print.text(part.text.trim())
      return
    }
    if (part.type === "reasoning" && input.thinking) {
      if (!once(`${part.messageID}:${part.id}`)) return
      if (input.emit("reasoning", { part })) return
      if (part.text.trim()) input.print.reasoning(part.text.trim())
    }
  }

  async function answerPermission(properties: unknown) {
    const requestID = field(properties, "id")
    const owner = field(properties, "sessionID")
    if (typeof requestID !== "string" || typeof owner !== "string" || !sessions.has(owner)) return
    if (!input.auto) {
      const action = field(properties, "action")
      const resources = field(properties, "resources")
      input.print.warning(
        `permission requested: ${String(action)} (${Array.isArray(resources) ? resources.join(", ") : ""}); auto-rejecting`,
      )
    }
    await client.permissions.reply({
      sessionID: owner,
      requestID,
      reply: input.auto ? "once" : "reject",
    })
  }

  // Nobody can answer a question in a headless run; V1 denied the question tool
  // up front, V2 has no per-session rule for it, so decline each ask.
  async function rejectQuestion(properties: unknown) {
    const requestID = field(properties, "id")
    const owner = field(properties, "sessionID")
    if (typeof requestID !== "string" || typeof owner !== "string" || !sessions.has(owner)) return
    await client.questions.reject({ sessionID: owner, requestID })
  }

  // session.wait returns once the agent loop is idle; it is a long request, so
  // retry it if the connection drops before the session settles.
  async function waitIdle(): Promise<void> {
    if (abort.signal.aborted) return
    const error = await client.sessions.wait({ sessionID }, { signal: abort.signal }).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (error === undefined || abort.signal.aborted) return
    await Bun.sleep(500)
    return waitIdle()
  }

  function once(key: string) {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  function report(text: string, error: unknown) {
    errors.push(text)
    if (!input.emit("error", { error })) input.print.error(text)
    return text
  }

  function stepStart(messageID: string) {
    return { id: `${messageID}-step-start`, sessionID, messageID, type: "step-start" }
  }

  function stepFinish(info: { id: string; finish?: string; cost?: number; tokens?: unknown }) {
    return {
      id: `${info.id}-step-finish`,
      sessionID,
      messageID: info.id,
      type: "step-finish",
      reason: info.finish ?? "stop",
      cost: info.cost ?? 0,
      tokens: info.tokens,
    }
  }
}

async function applySelection(input: HeadlessInput) {
  const session = await input.client.sessions.get({ sessionID: input.sessionID }, {})
  const current = session
  if (input.agent && current.agent !== input.agent)
    await input.client.sessions.switchAgent({ sessionID: input.sessionID, agent: input.agent }, {})
  if (!input.model) return
  await input.client.sessions.switchModel(
    {
      sessionID: input.sessionID,
      model: { id: input.model.modelID, providerID: input.model.providerID, variant: input.variant },
    },
    {},
  )
}

async function missingModel(input: HeadlessInput) {
  if (!input.model) return undefined
  const model = input.model
  const listed = await input.client.models
    .list({ location: { directory: input.directory } })
    .then((result) => result.data)
    .catch(() => undefined)
  // An unreadable catalog is not proof the model is missing; let the run report it.
  if (!listed) return undefined
  if (listed.some((item) => item.providerID === model.providerID && item.id === model.modelID)) return undefined
  return `Model not found: ${model.providerID}/${model.modelID}`
}

async function context(client: Client, sessionID: string): Promise<SessionMessage[]> {
  const result = await client.sessions.context({ sessionID }, {})
  return mutableResponse(result)
}

// `/api/event` carries the payload in `data`.
function asEvent(value: unknown) {
  const type = field(value, "type")
  if (typeof type !== "string") return undefined
  return { type, properties: field(value, "data") }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function errorText(error: unknown): string {
  const data = field(error, "data")
  const message = field(data, "message") ?? field(error, "message")
  if (typeof message === "string") return message
  const name = field(error, "name")
  return typeof name === "string" ? name : String(error)
}
