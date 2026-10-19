import { DateTime, Schema } from "effect"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { SessionMessage } from "@miao/schema/session-message"
import { Prompt } from "@miao/schema/prompt"
import { SessionTranscript } from "@miao/core/session/transcript"
import { messageID } from "./identity"
import { replayJournal } from "./journal"

const Sequence = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Snapshot = Schema.Struct({
  session_id: Schema.String,
  cursor: Sequence,
  transfer_import: Schema.optional(Schema.NullOr(Schema.String)),
  active_run: Schema.optional(Schema.NullOr(Schema.String)),
  messages: Schema.Array(
    Schema.Struct({
      seq: Sequence,
      role: Schema.String,
      identity: Schema.Struct({ anchor_seq: Sequence.pipe(Schema.optional) }).pipe(Schema.optional),
    }),
  ),
  selection: Schema.NullOr(
    Schema.Struct({
      through_seq: Sequence,
      seq: Sequence,
      summary: Schema.String,
      recorded_at_ms: Schema.NullOr(Sequence),
    }),
  ),
})
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const encodeEvent = Schema.encodeSync(OpenCodeEvent)
// Rendering drafts may contain explicit undefined optionals; JSON wire
// encoding omits them before the canonical message codec decodes timestamps.
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(SessionMessage.Message))

/** Read-only, captured native transcript. The snapshot owns visibility and the
 * compaction cut; journal projections own IDs, tool states, identity and usage.
 * Nothing is copied into the TypeScript durable Session store. */
export async function readTranscript(
  input: Omit<Parameters<typeof replayJournal>[0], "after" | "limit"> & { selected: boolean },
) {
  const raw = await input.request("snapshot", { session_id: input.sessionID })
  const snapshot = decodeSnapshot(raw)
  if (snapshot.session_id !== input.sessionID) throw new Error("Native transcript Session mismatch")
  // Replay exactly the captured snapshot, not a newer generation observed by
  // replayJournal's own snapshot request.
  const page = await replayJournal({
    ...input,
    after: 0,
    request: (method, params) => (method === "snapshot" ? Promise.resolve(raw) : input.request(method, params)),
  })
  const active = new Set(
    snapshot.messages
      .filter((row) => !input.selected || !snapshot.selection || row.seq > snapshot.selection.through_seq)
      .map((row) => row.seq),
  )
  const ids = new Set<string>()
  for (const row of snapshot.messages) {
    if (row.role === "assistant" && active.has(row.seq))
      ids.add(messageID(input.sessionID, row.identity?.anchor_seq ?? row.seq))
  }
  const shells = new Map<string, { id: SessionMessage.ID; runID: unknown }>()
  const reducer = SessionTranscript.create()
  let messages: SessionTranscript.Reduction["messages"] = []
  for (const event of page.events) {
    if (event.type === "session.next.shell.started")
      shells.set(event.data.callID, { id: event.data.messageID, runID: event.data.metadata?.runID })
    if (event.type === "session.next.shell.ended") {
      const shell = shells.get(event.data.callID)
      if (shell && active.has(sequence(event))) ids.add(shell.id)
      shells.delete(event.data.callID)
    }
    if (
      (event.type === "session.next.prompt.admitted" || event.type === "session.next.synthetic") &&
      active.has(sequence(event))
    )
      ids.add(event.data.messageID)
    const reduced = project(reducer, messages, event)
    if (reduced) messages = reduced.messages
  }
  for (const shell of shells.values())
    if (typeof shell.runID === "string" && shell.runID === snapshot.active_run) ids.add(shell.id)
  const result = messages
    .filter((message) => ids.has(message.id))
    .map((message) => decodeMessage(JSON.stringify(message)))
  if (input.selected && snapshot.selection) {
    // The engine does not record an automatic/manual reason on its legacy
    // compaction event. Render an honest summary, not a fabricated reason.
    result.unshift(
      SessionMessage.System.make({
        id: messageID(input.sessionID, snapshot.selection.seq),
        type: "system",
        time: {
          created:
            snapshot.selection.recorded_at_ms === null ? null : DateTime.makeUnsafe(snapshot.selection.recorded_at_ms),
        },
        text: `<history-summary>\n${snapshot.selection.summary}\n</history-summary>`,
        metadata: { nativeCompaction: { throughSequence: snapshot.selection.through_seq } },
      }),
    )
  }
  if (!snapshot.transfer_import) return result
  const imported = await readTransferred(input, snapshot.transfer_import, snapshot.cursor)
  const identities = new Set(imported.map((message) => message.id))
  if (result.some((message) => identities.has(message.id)))
    throw new Error("Transferred and native message IDs collide")
  return input.selected && snapshot.selection ? [result[0], ...imported, ...result.slice(1)] : [...imported, ...result]
}

const TransferPage = Schema.Struct({
  id: Schema.String,
  bundle_sha256: Schema.String,
  after: Sequence,
  next: Schema.NullOr(Sequence),
  messages: Schema.Array(SessionMessage.Message),
})

async function readTransferred(input: Parameters<typeof readTranscript>[0], id: string, cursor: number) {
  const messages: SessionMessage.Message[] = []
  const identities = new Set<string>()
  const state = { after: 0, digest: "" }
  while (true) {
    const page = Schema.decodeUnknownSync(TransferPage)(
      await input.request(input.selected ? "transfer_context" : "transfer_timeline", {
        session_id: input.sessionID,
        after: state.after,
        ...(input.selected ? { cursor } : {}),
      }),
    )
    if (page.id !== id || page.after !== state.after || (state.digest && page.bundle_sha256 !== state.digest))
      throw new Error("Transferred timeline changed during pagination")
    state.digest = page.bundle_sha256
    for (const message of page.messages) {
      if (identities.has(message.id)) throw new Error("Transferred timeline has duplicate canonical IDs")
      identities.add(message.id)
      messages.push(message)
    }
    if (page.next === null) return messages
    if (page.next <= state.after || !page.messages.length)
      throw new Error("Transferred timeline cursor did not advance")
    state.after = page.next
  }
}

function sequence(event: OpenCodeEvent): number {
  const engine = event.metadata?.engine
  if (typeof engine !== "object" || engine === null || !("seq" in engine) || typeof engine.seq !== "number")
    throw new Error("Native transcript event has no provenance")
  return engine.seq
}

function prompt(value: Schema.Codec.Encoded<typeof Prompt>) {
  return {
    ...value,
    files: value.files?.map((file) => ({ ...file })),
    agents: value.agents?.map((agent) => ({ ...agent })),
  }
}

/** The rendering event view is mutable-owned JSON; canonical wire schemas are
 * readonly. Copy array fields at this projection boundary instead of casting
 * away readonly or creating a second transcript reducer. */
function project(
  reducer: ReturnType<typeof SessionTranscript.create>,
  source: SessionTranscript.Reduction["messages"],
  event: OpenCodeEvent,
) {
  const wire = encodeEvent(event)
  switch (wire.type) {
    case "session.next.prompt.admitted":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: { ...wire.data, prompt: prompt(wire.data.prompt) },
      })
    case "session.next.prompted":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: { ...wire.data, prompt: prompt(wire.data.prompt) },
      })
    case "session.next.command.completed":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: { ...wire.data, prompt: prompt(wire.data.prompt) },
      })
    case "session.next.step.ended":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: { ...wire.data, files: wire.data.files?.slice() },
      })
    case "session.next.tool.progress":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: { ...wire.data, content: wire.data.content.map((item) => ({ ...item })) },
      })
    case "session.next.tool.success":
      return reducer.reduce(source, {
        id: wire.id,
        type: wire.type,
        properties: {
          ...wire.data,
          content: wire.data.content.map((item) => ({ ...item })),
          outputPaths: wire.data.outputPaths?.slice(),
        },
      })
    case "session.next.assistant.identity":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.stream.discarded":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.agent.switched":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.model.switched":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.synthetic":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.notification.admitted":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.delegation.reported":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.command.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.command.failed":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.shell.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.shell.ended":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.step.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.step.failed":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.text.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.text.delta":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.text.ended":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.reasoning.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.reasoning.delta":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.reasoning.ended":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.tool.input.started":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.tool.input.delta":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.tool.input.ended":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.tool.called":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    case "session.next.tool.failed":
      return reducer.reduce(source, { id: wire.id, type: wire.type, properties: wire.data })
    default:
      return undefined
  }
}
