import { BlackboxTape } from "@miao/core/blackbox/tape"
import { Schema } from "effect"
import type { EngineEvent } from "@/engine/client"

const Settlement = Schema.Struct({
  output: Schema.Json,
  is_error: Schema.Boolean,
  output_json: Schema.optional(Schema.String),
})

/** One subscribed engine Session. Associate provider content with run-scoped
 * engine call keys, and record only dispatched executors (not denied plans). */
export class EngineTools {
  #run = ""
  #inputs = new Map<string, { name: string; input: Schema.Json }>()
  #planned = new Map<string, { run: string; providerID: string }>()
  #tickets = new Map<string, Promise<Awaited<ReturnType<BlackboxTape.Recorder["begin"]>>>>()
  #receipts = new Map<string, BlackboxTape.Interaction>()

  constructor(readonly tape: BlackboxTape.Recorder | BlackboxTape.Replay) {}

  async observe(event: EngineEvent) {
    const data = BlackboxTape.json(event.data)
    if (!BlackboxTape.isObject(data)) return
    if (event.kind === "run.started" && typeof data.run_id === "string") this.#run = data.run_id
    if (event.kind === "message.committed" && data.role === "assistant" && Array.isArray(data.content)) {
      data.content.filter(BlackboxTape.isObject).forEach((block) => {
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          block.input === undefined
        )
          return
        this.#inputs.set(`${this.#run}:${block.id}`, { name: block.name, input: block.input })
      })
    }
    if (
      event.kind === "tool.planned" &&
      typeof data.call_id === "string" &&
      typeof data.provider_id === "string" &&
      typeof data.run_id === "string"
    ) {
      // Plans precede the assistant projection in the same engine commit.
      this.#planned.set(data.call_id, { run: data.run_id, providerID: data.provider_id })
    }
    if (event.kind === "tool.dispatched" && typeof data.call_id === "string") {
      const planned = this.#planned.get(data.call_id)
      const input = planned ? this.#inputs.get(`${planned.run}:${planned.providerID}`) : undefined
      if (!input) throw new Error("Native tool dispatch has no assistant input and plan")
      if (this.tape instanceof BlackboxTape.Replay) {
        this.#receipts.set(data.call_id, this.tape.take("native-tool", input))
        return
      }
      const ticket = this.tape.begin("native-tool", input)
      this.#tickets.set(data.call_id, ticket)
      await ticket
    }
    if (event.kind !== "tool.completed" || typeof data.call_id !== "string") return
    const result = Schema.decodeUnknownSync(Settlement)({
      output: data.result,
      is_error: data.is_error ?? false,
      ...(typeof data.result_json === "string" ? { output_json: data.result_json } : {}),
    })
    const recorded = this.#receipts.get(data.call_id)
    if (recorded) {
      if (
        recorded.outcome !== "complete" ||
        recorded.frames.length !== 1 ||
        BlackboxTape.canonical(recorded.frames[0].value) !== BlackboxTape.canonical(result)
      )
        throw new Error("Native tool replay settlement differs from the recording")
      this.#receipts.delete(data.call_id)
      return
    }
    const pending = this.#tickets.get(data.call_id)
    if (!pending) return
    const ticket = await pending
    await ticket.frame(result)
    await ticket.finish("complete")
    this.#tickets.delete(data.call_id)
  }
}
