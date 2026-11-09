import { describe, expect, test } from "bun:test"
import type { EngineEvent } from "@miao/client/engine"
import { createEngineReader, type EngineTransport } from "./engine-reader"

// Captured from `session_catalog` on `miao serve` built from this tree.
const catalog = [
  {
    session_id: "ses_b",
    title: "Catalog probe",
    updated_at_ms: 1794232836295,
    archived_at_ms: null,
    parent_session_id: null,
    pinned_at_ms: null,
    preview: null,
  },
  { session_id: "ses_a", title: "Older", updated_at_ms: 1794232800000, archived_at_ms: null },
  { session_id: "ses_c", title: "Archived", updated_at_ms: 1794232900000, archived_at_ms: 1794232900001 },
]

const snapshot = {
  session_id: "ses_b",
  title: "Catalog probe",
  cursor: 7,
  message_count: 3,
  has_messages: true,
  pending: [{}, {}],
  approvals: [{}],
}

// The transport's own HTTP behaviour is covered in `packages/client`, where a
// real server runs outside happy-dom; here the reader's composition is the subject.
function transport(result: Record<string, unknown>) {
  const calls: Array<{ method: string; params?: unknown }> = []
  const subscribed: string[] = []
  let onEvent: ((event: EngineEvent) => void) | undefined
  const fake: EngineTransport = {
    request: async (method, params) => {
      calls.push({ method, params })
      if (method in result) return result[method]
      throw new Error(`unexpected ${method}`)
    },
    subscribe: async (session) => {
      subscribed.push(session)
    },
    onEvent: (handler) => {
      onEvent = handler
    },
    close: async () => {},
  }
  return { fake, calls, subscribed, emit: (event: EngineEvent) => onEvent?.(event) }
}

describe("engine reader", () => {
  test("reads the catalog, newest first, hiding archived Sessions", async () => {
    const { fake, calls } = transport({ session_catalog: catalog })
    const reader = createEngineReader({ url: "http://127.0.0.1:4096", token: "t", transport: fake })
    try {
      expect((await reader.sessions()).map((session) => session.title)).toEqual(["Catalog probe", "Older"])
      expect((await reader.sessions({ includeArchived: true })).map((session) => session.title)).toEqual([
        "Archived",
        "Catalog probe",
        "Older",
      ])
      expect(calls[0]).toEqual({ method: "session_catalog" })
    } finally {
      await reader.close()
    }
  })

  test("reads one Session's header", async () => {
    const { fake, calls } = transport({ snapshot })
    const reader = createEngineReader({ url: "http://127.0.0.1:4096", token: "t", transport: fake })
    try {
      expect(await reader.snapshot("ses_b")).toMatchObject({
        id: "ses_b",
        cursor: 7,
        messageCount: 3,
        hasMessages: true,
        pending: 2,
        approvals: 1,
      })
      expect(calls[0]).toEqual({ method: "snapshot", params: { session_id: "ses_b" } })
    } finally {
      await reader.close()
    }
  })

  test("opens one stream per Session and fans events out to its subscribers", async () => {
    const { fake, subscribed, emit } = transport({})
    const reader = createEngineReader({ url: "http://127.0.0.1:4096", token: "t", transport: fake })
    const first: number[] = []
    const second: number[] = []
    const other: number[] = []
    try {
      const off = await reader.subscribe("ses_b", (event) => first.push(event.seq))
      await reader.subscribe("ses_b", (event) => second.push(event.seq))
      await reader.subscribe("ses_a", (event) => other.push(event.seq))
      expect(subscribed).toEqual(["ses_b", "ses_a"])

      emit({ session_id: "ses_b", seq: 1, kind: "message.updated", data: {} })
      emit({ session_id: "ses_b", seq: 2, kind: "message.updated", data: {} })
      emit({ session_id: "ses_a", seq: 9, kind: "message.updated", data: {} })
      expect(first).toEqual([1, 2])
      expect(second).toEqual([1, 2])
      expect(other).toEqual([9])

      off()
      emit({ session_id: "ses_b", seq: 3, kind: "message.updated", data: {} })
      expect(first).toEqual([1, 2])
      expect(second).toEqual([1, 2, 3])
    } finally {
      await reader.close()
    }
  })
})
