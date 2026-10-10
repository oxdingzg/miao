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
export type EngineSessionEvent = { type: string; data: unknown }
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
  #subscribed = new Set<string>()

  constructor(client: EngineClient, publish: EnginePublish) {
    this.#client = client
    this.#publish = publish
    client.onEvent((event) => this.#dispatch(event))
  }

  /** Subscribe (once per Session) before admitting so no committed event is missed. */
  async prompt(sessionID: string, prompt: string): Promise<unknown> {
    if (!this.#subscribed.has(sessionID)) {
      await this.#client.subscribe(sessionID, 0)
      this.#subscribed.add(sessionID)
    }
    return this.#client.admit({ session_id: sessionID, input_id: `in_${crypto.randomUUID()}`, prompt })
  }

  #dispatch(event: EngineEvent): void {
    const publish = this.#publish
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
