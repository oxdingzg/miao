export * as RuntimeControlLive from "./control-live"

export type Part = { id: string; kind: "text" | "reasoning"; text: string; truncated: boolean }
type Session = {
  messageID: string
  parts: Map<string, Part & { bytes: number }>
  revision: number
  touched: number
  bytes: number
}

/** Ephemeral full values: never journal fragments or use their revision as a durable cursor. */
export function make(now = Date.now) {
  const sessions = new Map<string, Session>()
  const epoch = crypto.randomUUID()
  const encoder = new TextEncoder()
  const maximum = 256 * 1024
  const state = { bytes: 0, revision: 0 }
  const remove = (id: string) => {
    const session = sessions.get(id)
    if (!session) return
    state.bytes -= session.bytes
    sessions.delete(id)
  }
  const prune = () => {
    for (const [id, session] of sessions) if (now() - session.touched > 120_000) remove(id)
    while (sessions.size > 64 || state.bytes > 4 * 1024 * 1024) remove(sessions.keys().next().value!)
  }
  return {
    accept(event: { type: string; data: unknown }) {
      if (!event.type.startsWith("session.next.")) return
      if (typeof event.data !== "object" || event.data === null) return
      const data = event.data as Record<string, unknown>
      if (typeof data.sessionID !== "string" || typeof data.assistantMessageID !== "string") return
      prune()
      if (event.type === "session.next.step.started") {
        remove(data.sessionID)
        sessions.set(data.sessionID, {
          messageID: data.assistantMessageID,
          parts: new Map(),
          revision: ++state.revision,
          touched: now(),
          bytes: 0,
        })
        prune()
        return
      }
      const session = sessions.get(data.sessionID)
      // A delayed event from an older assistant turn cannot replace the current live value.
      if (!session || session.messageID !== data.assistantMessageID) return
      if (["session.next.step.ended", "session.next.step.failed"].includes(event.type)) {
        remove(data.sessionID)
        return
      }
      const kind = event.type.startsWith("session.next.text.")
        ? "text"
        : event.type.startsWith("session.next.reasoning.")
          ? "reasoning"
          : undefined
      if (!kind) return
      const id = kind === "text" ? data.textID : data.reasoningID
      if (typeof id !== "string") return
      const key = kind + ":" + id
      if (event.type.endsWith(".started")) {
        if (session.parts.has(key) || session.parts.size >= 32) return
        session.parts.set(key, { id, kind, text: "", truncated: false, bytes: 0 })
      }
      const part = session.parts.get(key)
      if (!part) return
      if (event.type.endsWith(".ended")) {
        const size = part.bytes
        session.bytes -= size
        state.bytes -= size
        session.parts.delete(key)
      }
      if (event.type.endsWith(".delta") && typeof data.delta === "string" && !part.truncated) {
        const previous = part.bytes
        const next = encoder.encode(data.delta.slice(0, maximum + 4))
        const available = maximum - previous
        if (next.length <= available) {
          part.text += data.delta
          part.bytes += next.length
        }
        if (next.length > available) {
          // fatal decoding backs off an incomplete UTF-8 scalar at the size boundary.
          const decoder = new TextDecoder("utf-8", { fatal: true })
          for (let length = available; length >= Math.max(0, available - 3); length--) {
            try {
              part.text += decoder.decode(next.subarray(0, length))
              part.bytes += length
              break
            } catch {}
          }
          part.truncated = true
        }
        const added = part.bytes - previous
        session.bytes += added
        state.bytes += added
      }
      session.revision = ++state.revision
      session.touched = now()
      prune()
    },
    snapshot(sessionID: string) {
      prune()
      const session = sessions.get(sessionID)
      return {
        epoch,
        revision: session?.revision ?? state.revision,
        messageID: session?.messageID ?? null,
        parts: session
          ? [...session.parts.values()].map((part) => ({
              id: part.id,
              kind: part.kind,
              text: part.text,
              truncated: part.truncated,
            }))
          : [],
      }
    },
    clear() {
      sessions.clear()
      state.bytes = 0
      state.revision++
    },
  }
}
