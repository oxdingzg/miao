import { Schema } from "effect"
import { Prompt } from "@miao/schema/prompt"
import { SessionInput } from "@miao/schema/session-input"
import { SessionMessage } from "@miao/schema/session-message"
import { SessionID } from "@miao/schema/session-id"
import { EngineClient, EngineError, type EngineEvent } from "./client"
import {
  StatusBridge,
  ToolBridge,
  PromptBridge,
  translateApproval,
  translateApprovalResolved,
  translateAssistantIdentity,
  translateMessage,
  translateProviderRequest,
  translateProviderRequestResult,
  translateRetried,
  translateRunFailure,
  translateQuestion,
  translateTools,
} from "./bridge"

/** One bridged product event ready to publish onto the product event bus. */
export type EngineSessionEvent = {
  type: string
  data: unknown
  source: { sessionID: string; seq: number; index: number; recordedAtMs?: number | null }
}
export type EnginePublish = (event: EngineSessionEvent) => void

/**
 * The B1 façade seam: it drives one engine Session and translates its events into
 * product events through the bridge, handing them to an injected publisher. It
 * owns no product event-bus dependency, so the handler wiring decides where the
 * events land.
 */
export class EngineSession {
  #client: EngineClient
  #publish: EnginePublish
  #status = new StatusBridge()
  #tools = new ToolBridge()
  #prompts = new PromptBridge()
  #subscriptions = new Map<string, { mode: "live" | "restored"; ready: Promise<unknown> }>()

  constructor(client: EngineClient, publish: EnginePublish) {
    this.#client = client
    this.#publish = publish
    client.onEvent((event) => this.#dispatch(event))
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
        this.#dispatch(event)
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
    if (
      typeof event !== "object" ||
      event === null ||
      !("session_id" in event) ||
      event.session_id !== input.sessionID ||
      !("seq" in event) ||
      event.seq !== admitted.admitted_seq ||
      !("kind" in event) ||
      event.kind !== "input.admitted" ||
      !("recorded_at_ms" in event) ||
      typeof event.recorded_at_ms !== "number" ||
      !Number.isSafeInteger(event.recorded_at_ms) ||
      event.recorded_at_ms < 0 ||
      !("data" in event) ||
      typeof event.data !== "object" ||
      event.data === null ||
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
    })
  }

  #dispatch(event: EngineEvent): void {
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
    const status = this.#status.update(event)
    if (status) publish({ type: "session.next.status", data: status })
    const admitted = this.#prompts.project(event)
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
  }
}

function isReplayEvent(value: unknown, sessionID: string): value is EngineEvent {
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
