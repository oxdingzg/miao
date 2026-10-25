import { chronological } from "../util/message-order"
import { createStore, produce } from "solid-js/store"
import type { SessionMessage, TranscriptUserMessage } from "@miao/schema/view-models"

export type PendingPrompt = {
  info: TranscriptUserMessage
  sessionID: string
  state: "sending" | "admitted" | "failed"
  delivery: "steer" | "queue"
  error?: string
  retries?: number
}

// Local display receipts are deliberately separate from projected history.
// Admission is visible to the user, but only Prompted makes it model-visible.
export function createPendingPrompts() {
  const [data, setData] = createStore<Record<string, PendingPrompt>>({})
  // Durably admitted prompts still waiting for promotion, oldest first.
  // In-flight ("sending") receipts are excluded: the server may not have
  // admitted them yet, so cancelling one is a race.
  const waiting = (sessionID: string) => {
    const pending = Object.values(data).filter((prompt) => prompt.sessionID === sessionID && prompt.state === "admitted")
    return chronological(pending.map((prompt) => ({ id: prompt.info.id, time: prompt.info.time, prompt }))).map(
      (item) => item.prompt,
    )
  }
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
    retry(id: string, retries: number, error: string) {
      if (data[id]?.state !== "sending") return
      setData(id, { retries, error })
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
    reconcile(sessionID: string, messages: ReadonlyArray<SessionMessage>) {
      const projected = new Set(messages.map((message) => message.id))
      setData(
        produce((draft) => {
          Object.values(draft)
            .filter((prompt) => prompt.sessionID === sessionID && projected.has(prompt.info.id))
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
            .filter((prompt) => prompt.sessionID === sessionID)
            .forEach((prompt) => {
              delete draft[prompt.info.id]
            })
        }),
      )
    },
    waiting,
    // The footer renders one receipt line. Receipts enter in send order, so the
    // last one for this Session is the prompt whose state the user is waiting on.
    latest(sessionID: string): PendingPrompt | undefined {
      let found: PendingPrompt | undefined
      for (const prompt of Object.values(data)) {
        if (prompt.sessionID === sessionID) found = prompt
      }
      return found
    },
    // The one prompt esc removes and the up arrow takes back for editing: the
    // newest admitted prompt. Two actions on the same target must not disagree
    // about which message the user is pointing at.
    newest(sessionID: string): PendingPrompt | undefined {
      return waiting(sessionID).at(-1)
    },
    messages(sessionID: string, projected: ReadonlyArray<SessionMessage>): SessionMessage[] {
      const ids = new Set(projected.map((message) => message.id))
      const pending = chronological(Object.values(data)
        .filter((prompt) => prompt.sessionID === sessionID && !ids.has(prompt.info.id))
        .map((prompt) => prompt.info))
      // Projected history is authoritative and already ordered by the server.
      // Receipts for prompts that have not been promoted yet always belong at
      // the tail: mixing them by `time.created` would let a client clock that
      // trails the server insert the echo above older history.
      return [...projected, ...pending]
    },
  }
}
