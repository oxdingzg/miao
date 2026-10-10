import { BlackboxTape } from "@miao/core/blackbox/tape"
import type { EngineEvent } from "@/engine/client"

/** Only documented identity fields are alpha-renamed. Tool parameters, file
 * paths, user text, result values, and unknown event fields stay significant. */
export class EngineTrace {
  #ids = new Map<string, Map<string, string>>()

  #id(domain: string, value: string) {
    const ids = this.#ids.get(domain) ?? new Map<string, string>()
    this.#ids.set(domain, ids)
    const id = ids.get(value) ?? `${domain}_${ids.size}`
    ids.set(value, id)
    return id
  }

  project(event: EngineEvent): BlackboxTape.Trace {
    const value = BlackboxTape.json(event.data)
    const data = BlackboxTape.isObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, input]) => {
            const domains: Record<string, string | undefined> = {
              run_id: "run",
              input_id: "input",
              call_id: "call",
              provider_id: "provider-call",
              message_id: "message",
              checkpoint: "checkpoint",
              request_id: "approval",
            }
            const domain = domains[key]
            if (domain && typeof input === "string") return [key, this.#id(domain, input)]
            if (key === "content" && Array.isArray(input))
              return [
                key,
                input.map((block) => {
                  if (!BlackboxTape.isObject(block)) return block
                  if (block.type === "tool_use" && typeof block.id === "string")
                    return { ...block, id: this.#id("provider-call", block.id) }
                  if (block.type === "tool_result" && typeof block.tool_use_id === "string")
                    return { ...block, tool_use_id: this.#id("provider-call", block.tool_use_id) }
                  return block
                }),
              ]
            return [key, input]
          }),
        )
      : value
    return { session: "root", kind: event.kind, data, recordedAtMs: event.recorded_at_ms ?? null }
  }
}
