import type { Part } from "@miao/schema/view-models"

// This is a display-only view of the envelope emitted by send_message. Keep
// the original prompt text intact for model history, copying and export.
export function parseSessionMessage(text: string) {
  const match = /^<message from session="(ses_[A-Za-z0-9_-]+)">\r?\n([\s\S]*?)\r?\n<\/message>$/.exec(text)
  if (!match) return
  return { sessionID: match[1], body: match[2] }
}

export interface SessionMessageEntry {
  /** Part id, so a row keeps a stable identity across renders. */
  id: string
  direction: "in" | "out"
  /** Source session id for an inbound message, or the send target for an outbound one. */
  peer: string
  body: string
  reason?: string
  wake?: "requested" | "not_requested"
}

/**
 * Cross-Session messages visible in a Session transcript: an inbound peer message
 * arrives as user text in the send_message envelope, an outbound one as a
 * completed send_message tool call. Both directions are derived from data the TUI
 * already syncs, in transcript order, so the sidebar needs no extra request.
 */
export function sessionMessageEntries(
  messages: ReadonlyArray<{ id: string; role?: string }>,
  parts: (messageID: string) => ReadonlyArray<Part>,
): SessionMessageEntry[] {
  return messages.flatMap((message) =>
    parts(message.id).flatMap((part): SessionMessageEntry[] => {
      if (part.type === "tool" && part.tool === "send_message" && part.state.status === "completed") {
        const input = part.state.input as { to?: unknown; message?: unknown; reason?: unknown }
        if (typeof input.to !== "string" || typeof input.message !== "string") return []
        const wake = part.state.metadata?.wake
        const target = part.state.metadata?.sessionID
        return [
          {
            id: part.id,
            direction: "out",
            peer: typeof target === "string" ? target : input.to,
            body: input.message,
            ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
            ...(wake === "requested" || wake === "not_requested" ? { wake } : {}),
          },
        ]
      }
      if (message.role !== "user" || part.type !== "text") return []
      const parsed = parseSessionMessage(part.text)
      return parsed ? [{ id: part.id, direction: "in", peer: parsed.sessionID, body: parsed.body }] : []
    }),
  )
}
