import { EngineClient, type EngineEvent } from "./client"
import {
  StatusBridge,
  ToolBridge,
  translateApproval,
  translateApprovalResolved,
  translateMessage,
  translatePrompt,
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
  #subscriptions = new Map<string, Promise<unknown>>()

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
      this.#subscriptions.set(sessionID, subscription)
    }
    await this.#subscriptions.get(sessionID)
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
    const admitted = translatePrompt(event)
    if (admitted) publish({ type: "session.next.prompt.admitted", data: admitted })
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
