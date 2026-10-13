import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { replayJournal } from "@/engine/journal"
import { nativeSessionEvents } from "@miao/server/native-events"
import { SessionEvent } from "@miao/schema/session-event"
import { SessionID } from "@miao/schema/session-id"
import { AbsolutePath } from "@miao/schema/schema"

const sessionID = Schema.decodeUnknownSync(SessionID)("ses_journal")
const location = { directory: AbsolutePath.make("/tmp/journal") }
const row = (seq: number, text: string) => ({
  session_id: sessionID, seq, kind: "message.committed",
  data: { role: "assistant", content: [{ type: "text", text }] }, recorded_at_ms: 420,
})

test("replay envelopes survive the public durable codec and preserve reconnect identities", async () => {
  const request = async (method: string) => method === "snapshot"
    ? { session_id: sessionID, cursor: 2 }
    : [row(1, "first"), row(2, "second")]
  const full = await replayJournal({ sessionID, location, engineID: "store", after: 0, request })
  const resumed = await replayJournal({ sessionID, location, engineID: "store", after: 1, request })
  expect(resumed.events).toHaveLength(1)
  expect(resumed.events[0]).toEqual(full.events[1])
  expect(resumed.cursor).toBe(2)
  const wire = await Effect.runPromise(Schema.encodeEffect(SessionEvent.Durable)(
    Schema.decodeUnknownSync(Schema.toType(SessionEvent.Durable))(resumed.events[0]),
  ))
  expect(JSON.stringify(wire)).toContain('"text":"second"')
})

test("SSE advances past non-projecting rows and sees later commits without a handoff gap", async () => {
  const event = (await replayJournal({ sessionID, location, engineID: "store", after: 0,
    request: async (method) => method === "snapshot" ? { session_id: sessionID, cursor: 1 } : [row(1, "later")],
  })).events[0]
  const cursors: number[] = []
  const stream = nativeSessionEvents({ events: (input) => Effect.sync(() => {
    cursors.push(input.after)
    return cursors.length === 1 ? { events: [], cursor: 5 } : { events: [event], cursor: 6 }
  }) }, { sessionID, location, storage: AbsolutePath.make("/tmp/store"), after: 0 })
  const values = await Effect.runPromise(stream.pipe(Stream.take(1), Stream.runCollect))
  expect(values).toHaveLength(1)
  expect(cursors).toEqual([0, 5])
})

test("a discontinuous journal fails instead of silently truncating replay", async () => {
  await expect(replayJournal({ sessionID, location, engineID: "store", after: 0,
    request: async (method) => method === "snapshot" ? { session_id: sessionID, cursor: 2 } : [row(2, "gap")],
  })).rejects.toThrow("discontinuous")
})
