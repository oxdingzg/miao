import { createStore, produce } from "solid-js/store"
import type { Message, Part, UserMessage } from "@miao/schema/view-models"

export type PendingPrompt = {
  info: UserMessage
  parts: Part[]
  state: "sending" | "admitted" | "failed"
  delivery: "steer" | "queue"
  error?: string
}

// Local display receipts are deliberately separate from projected history.
// Admission is visible to the user, but only Prompted makes it model-visible.
export function createPendingPrompts() {
  const [data, setData] = createStore<Record<string, PendingPrompt>>({})
  return {
    data,
    add(prompt: PendingPrompt) {
      if (data[prompt.info.id]) return
      setData(prompt.info.id, prompt)
    },
    admit(id: string) {
      if (!data[id]) return
      setData(id, { state: "admitted", error: undefined })
    },
    fail(id: string, error: string) {
      if (data[id]?.state !== "sending") return
      setData(id, { state: "failed", error })
    },
    remove(id: string) {
      setData(
        produce((draft) => {
          delete draft[id]
        }),
      )
    },
    reconcile(sessionID: string, messages: ReadonlyArray<Message>) {
      const projected = new Set(messages.map((message) => message.id))
      setData(
        produce((draft) => {
          Object.values(draft)
            .filter((prompt) => prompt.info.sessionID === sessionID && projected.has(prompt.info.id))
            .forEach((prompt) => {
              delete draft[prompt.info.id]
            })
        }),
      )
    },
    clear(sessionID: string) {
      setData(
        produce((draft) => {
          Object.values(draft)
            .filter((prompt) => prompt.info.sessionID === sessionID)
            .forEach((prompt) => {
              delete draft[prompt.info.id]
            })
        }),
      )
    },
    messages(sessionID: string, projected: ReadonlyArray<Message>): Message[] {
      const ids = new Set(projected.map((message) => message.id))
      const pending = Object.values(data)
        .filter((prompt) => prompt.info.sessionID === sessionID && !ids.has(prompt.info.id))
        .map((prompt) => prompt.info)
        .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      // Projected history is authoritative and already ordered by the server.
      // Receipts for prompts that have not been promoted yet always belong at
      // the tail: mixing them by `time.created` would let a client clock that
      // trails the server insert the echo above older history.
      return [...projected, ...pending]
    },
  }
}
