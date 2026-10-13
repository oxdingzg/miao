import { DateTime, Schema } from "effect"
import { Prompt } from "@miao/schema/prompt"
import { SessionInput } from "@miao/schema/session-input"
import { SessionMessage } from "@miao/schema/session-message"
import { SessionID } from "@miao/schema/session-id"
import { EngineClient, EngineError, type EngineEvent, type EngineProgress } from "./client"
import { adoptSession, messageID } from "./identity"
import {
  StatusBridge,
  ToolBridge,
  PromptBridge,
  translateApproval,
  translateApprovalResolved,
  translateAssistantIdentity,
  translateMessage,
  translateCopiedPrompt,
  translateProviderRequest,
  translateProviderRequestResult,
  translateQuestionResolved,
  translateRetried,
  translateRunFailure,
  translateQuestion,
  streamAnchor,
  translateDelta,
  translateTools,
  type StreamAnchor,
} from "./bridge"

/** One bridged product event ready to publish onto the product event bus. */
export type EngineSessionEvent = {
  type: string
  data: unknown
  source: { sessionID: string; seq: number; index: number; recordedAtMs?: number | null }
}
export type EnginePublish = (event: EngineSessionEvent) => void

/**
 * The per-Session translation state: the status/tool/prompt bridges plus the
 * settled-event cursor. Live delivery and journal replay share it, so replaying
 * a journalled page reconstructs exactly the events live delivery published.
 */
export class EngineTranslator {
  #publish: EnginePublish
  #status = new StatusBridge()
  #tools = new ToolBridge()
  #prompts = new PromptBridge()
  #settledThrough = new Map<string, number>()
  #anchors = new Map<string, StreamAnchor>()

  constructor(publish: EnginePublish) {
    this.#publish = publish
  }

  dispatch(event: EngineEvent): void {
    // The index is per event type, so suppressing an unrelated status update
    // cannot change a message's identity on replay.
    const counts = new Map<string, number>()
    const publish = (output: { type: string; data: unknown }) => {
      const index = counts.get(output.type) ?? 0
      counts.set(output.type, index + 1)
      this.#publish({
        ...output,
        source: {
          sessionID: event.session_id,
          seq: event.seq,
          index,
          recordedAtMs: event.recorded_at_ms ?? null,
        },
      })
    }
    this.#tools.note(event)
    const committed =
      event.kind === "message.committed" &&
      typeof event.data === "object" &&
      event.data !== null &&
      "role" in event.data &&
      event.data.role === "assistant"
    if (committed || event.kind === "run.finished") {
      // The durable boundary wins over late progress from the independent pipe.
      // Keep one cursor per subscribed Session, rather than retaining every run.
      this.#settledThrough.set(event.session_id, Math.max(this.#settledThrough.get(event.session_id) ?? 0, event.seq))
      for (const [key, anchor] of this.#anchors) {
        if (!key.startsWith(`${event.session_id}/`) || anchor.seq > event.seq) continue
        if (
          event.kind === "run.finished" &&
          anchor.nextDelta > 0 &&
          typeof event.recorded_at_ms === "number" &&
          Number.isSafeInteger(event.recorded_at_ms) &&
          event.recorded_at_ms >= 0
        ) {
          // Ephemeral closure must not shift the durable boundary's delivery ordinals.
          this.#publish({
            type: "session.next.stream.discarded",
            data: {
              sessionID: adoptSession(event.session_id),
              timestamp: DateTime.makeUnsafe(event.recorded_at_ms),
              assistantMessageID: messageID(event.session_id, anchor.seq),
            },
            source: {
              sessionID: event.session_id,
              seq: anchor.seq,
              index: anchor.nextDelta,
              recordedAtMs: anchor.recordedAtMs,
            },
          })
        }
        this.#anchors.delete(key)
      }
    }
    if (event.kind === "provider.started" && event.seq > (this.#settledThrough.get(event.session_id) ?? 0)) {
      const data: unknown = event.data
      const run = typeof data === "object" && data !== null && "run_id" in data ? data.run_id : undefined
      const step = typeof data === "object" && data !== null && "step" in data ? data.step : undefined
      if (
        typeof run === "string" &&
        typeof step === "number" &&
        !this.#anchors.has(`${event.session_id}/${run}/${step}`)
      )
        this.#anchors.set(`${event.session_id}/${run}/${step}`, streamAnchor(event.seq, event.recorded_at_ms ?? null))
    }
    const status = this.#status.update(event)
    if (status) publish({ type: "session.next.status", data: status })
    const admitted = this.#prompts.project(event) ?? translateCopiedPrompt(event)
    if (admitted) publish({ type: "session.next.prompt.admitted", data: admitted })
    const identity = translateAssistantIdentity(event)
    if (identity) publish({ type: "session.next.assistant.identity", data: identity })
    const failure = translateRunFailure(event)
    if (failure) publish({ type: "session.next.failed", data: failure })
    const retry = translateRetried(event)
    if (retry) publish({ type: "session.next.retried", data: retry })
    const request = translateProviderRequest(event)
    if (request) publish({ type: "session.next.provider.request", data: request })
    const requestResult = translateProviderRequestResult(event)
    if (requestResult) publish({ type: "session.next.provider.request.result", data: requestResult })
    for (const text of translateMessage(event)) publish({ type: "session.next.text.ended", data: text })
    for (const call of translateTools(event)) publish({ type: "session.next.tool.called", data: call })
    const result = this.#tools.result(event)
    if (result) publish({ type: result.type, data: result })
    const asked = translateApproval(event)
    if (asked) publish({ type: "permission.v2.asked", data: asked })
    const replied = translateApprovalResolved(event)
    if (replied) publish({ type: "permission.v2.replied", data: replied })
    const question = translateQuestion(event)
    if (question) publish({ type: "question.v2.asked", data: question })
    const resolved = translateQuestionResolved(event)
    if (resolved) publish({ type: resolved.type, data: resolved.data })
  }

  /** Live-only delta fragments, anchored to the durable step-start sequence. */
  progress(progress: EngineProgress): void {
    if (progress.kind !== "provider.delta") return
    const sessionID = progress.session_id
    if (typeof sessionID !== "string") return
    const run = progress.run_id
    const step = progress.step
    if (typeof run !== "string" || typeof step !== "number") return
    const key = `${sessionID}/${run}/${step}`
    const existing = this.#anchors.get(key)
    const seq = progress.anchor_seq
    const recorded = progress.recorded_at_ms
    const anchor =
      existing ??
      (typeof seq === "number" &&
      Number.isSafeInteger(seq) &&
      seq > 0 &&
      typeof recorded === "number" &&
      Number.isSafeInteger(recorded) &&
      recorded >= 0
        ? streamAnchor(seq, recorded)
        : undefined)
    if (!anchor || anchor.seq <= (this.#settledThrough.get(sessionID) ?? 0)) return
    this.#anchors.set(key, anchor)
    const fragment = translateDelta(progress, anchor)
    if (!fragment) return
    this.#publish({
      type: fragment.type,
      data: fragment.data,
      source: { sessionID, seq: anchor.seq, index: anchor.nextDelta++, recordedAtMs: anchor.recordedAtMs },
    })
  }
}

/**
 * The B1 façade seam: it drives one engine Session and translates its events into
 * product events through the bridge, handing them to an injected publisher. It
 * owns no product event-bus dependency, so the handler wiring decides where the
 * events land.
 */
export class EngineSession {
  #client: EngineClient
  #translator: EngineTranslator
  #subscriptions = new Map<string, { mode: "live" | "restored"; ready: Promise<unknown> }>()

  constructor(client: EngineClient, publish: EnginePublish) {
    this.#client = client
    this.#translator = new EngineTranslator(publish)
    client.onEvent((event) => this.#translator.dispatch(event))
    client.onProgress((progress) => this.#translator.progress(progress))
  }

  /** Subscribe before admitting; retain the caller's identity for exact retries. */
  async prompt(
    sessionID: string,
    prompt: string,
    options: { inputID?: string; delivery?: "steer" | "queue"; resume?: boolean } = {},
  ): Promise<unknown> {
    if (!this.#subscriptions.has(sessionID)) {
      const subscription = this.#client.subscribe(sessionID, 0).catch((error: unknown) => {
        this.#subscriptions.delete(sessionID)
        throw error
      })
      // Share the pending subscription too: concurrent admissions must not
      // replay the same history twice before either subscribe reply arrives.
      this.#subscriptions.set(sessionID, { mode: "live", ready: subscription })
    }
    await this.#subscriptions.get(sessionID)?.ready
    return this.#client.admit(
      {
        session_id: sessionID,
        input_id: options.inputID ?? `in_${crypto.randomUUID()}`,
        prompt,
        delivery: options.delivery,
      },
      options.resume ?? true,
    )
  }

  /** Replay a transactionally captured snapshot cursor before attaching live delivery. */
  restore(sessionID: string): Promise<unknown> {
    const existing = this.#subscriptions.get(sessionID)
    if (existing?.mode === "restored") return existing.ready
    if (existing)
      return Promise.reject(new EngineError("engine_already_subscribed", "restore requires an unattached Session"))
    const ready = this.#restore(sessionID).catch((error: unknown) => {
      this.#subscriptions.delete(sessionID)
      throw error
    })
    this.#subscriptions.set(sessionID, { mode: "restored", ready })
    return ready
  }

  async #restore(sessionID: string): Promise<unknown> {
    const snapshot = await this.#client.request("snapshot", { session_id: sessionID })
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !("cursor" in snapshot) ||
      !("session_id" in snapshot) ||
      snapshot.session_id !== sessionID ||
      typeof snapshot.cursor !== "number" ||
      !Number.isSafeInteger(snapshot.cursor) ||
      snapshot.cursor < 0
    )
      throw new EngineError("engine_snapshot_invalid", "native snapshot has no valid Session cursor")
    let after = 0
    while (after < snapshot.cursor) {
      const page = await this.#client.request("events", { session_id: sessionID, after })
      if (!Array.isArray(page) || page.length === 0)
        throw new EngineError("engine_replay_invalid", "native replay ended before the snapshot cursor")
      for (const event of page) {
        if (!isReplayEvent(event, sessionID) || event.seq !== after + 1)
          throw new EngineError("engine_replay_invalid", "native replay has an invalid or discontinuous event")
        if (event.seq > snapshot.cursor) break
        this.#translator.dispatch(event)
        after = event.seq
      }
    }
    // Events committed during snapshot/replay remain after this cursor. The
    // native subscription replays those rows before continuing live polling.
    await this.#client.subscribe(sessionID, snapshot.cursor)
    return snapshot
  }

  /** Product admission receipt sourced from the committed native admission row. */
  async promptProduct(input: {
    sessionID: SessionID
    prompt: Prompt
    id?: SessionMessage.ID
    delivery?: "steer" | "queue"
    resume?: boolean
  }): Promise<SessionInput.Admitted> {
    // The native prompt vocabulary currently carries plain text only. Reject
    // richer product inputs before admission, so they cannot be silently lost.
    if (input.prompt.command || input.prompt.files?.length || input.prompt.agents?.length)
      throw new EngineError("engine_prompt_unsupported", "native product admission currently requires plain text")
    const id = input.id ?? SessionMessage.ID.create()
    const delivery = input.delivery ?? "steer"
    const admitted = await this.prompt(input.sessionID, input.prompt.text, {
      inputID: id,
      delivery,
      resume: input.resume,
    })
    if (
      typeof admitted !== "object" ||
      admitted === null ||
      !("input_id" in admitted) ||
      admitted.input_id !== id ||
      !("admitted_seq" in admitted) ||
      typeof admitted.admitted_seq !== "number" ||
      !Number.isSafeInteger(admitted.admitted_seq) ||
      admitted.admitted_seq < 1
    )
      throw new EngineError("engine_admission_invalid", "native admission has no matching input sequence")
    const page = await this.#client.request("events", { session_id: input.sessionID, after: admitted.admitted_seq - 1 })
    const event: unknown = Array.isArray(page) ? page[0] : undefined
    const copied =
      "duplicate" in admitted &&
      admitted.duplicate === true &&
      "pending" in admitted &&
      admitted.pending === false &&
      typeof event === "object" &&
      event !== null &&
      "kind" in event &&
      event.kind === "message.committed"
    if (
      typeof event !== "object" ||
      event === null ||
      !("session_id" in event) ||
      event.session_id !== input.sessionID ||
      !("seq" in event) ||
      event.seq !== admitted.admitted_seq ||
      !("kind" in event) ||
      (event.kind !== "input.admitted" && !copied) ||
      !("recorded_at_ms" in event) ||
      typeof event.recorded_at_ms !== "number" ||
      !Number.isSafeInteger(event.recorded_at_ms) ||
      event.recorded_at_ms < 0 ||
      !("data" in event) ||
      typeof event.data !== "object" ||
      event.data === null ||
      (copied && (!("role" in event.data) || event.data.role !== "user")) ||
      !("input_id" in event.data) ||
      event.data.input_id !== id ||
      !("delivery" in event.data) ||
      event.data.delivery !== delivery
    )
      throw new EngineError("engine_admission_invalid", "native durable admission facts are missing or inconsistent")
    return Schema.decodeUnknownSync(SessionInput.Admitted)({
      id,
      sessionID: input.sessionID,
      admittedSeq: event.seq,
      delivery,
      prompt: { text: input.prompt.text },
      timeCreated: event.recorded_at_ms,
      ...(copied ? { promotedSeq: event.seq } : {}),
    })
  }
}

export function isReplayEvent(value: unknown, sessionID: string): value is EngineEvent {
  if (typeof value !== "object" || value === null) return false
  return (
    "session_id" in value &&
    value.session_id === sessionID &&
    "seq" in value &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq > 0 &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "data" in value &&
    (!("recorded_at_ms" in value) ||
      value.recorded_at_ms === null ||
      (typeof value.recorded_at_ms === "number" &&
        Number.isSafeInteger(value.recorded_at_ms) &&
        value.recorded_at_ms >= 0))
  )
}
