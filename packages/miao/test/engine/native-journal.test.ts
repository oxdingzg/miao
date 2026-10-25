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
  session_id: sessionID,
  seq,
  kind: "message.committed",
  data: { role: "assistant", content: [{ type: "text", text }] },
  recorded_at_ms: 420,
})

test("replay envelopes survive the public durable codec and preserve reconnect identities", async () => {
  const request = async (method: string) =>
    method === "snapshot" ? { session_id: sessionID, cursor: 2 } : [row(1, "first"), row(2, "second")]
  const full = await replayJournal({ sessionID, location, engineID: "store", after: 0, request })
  const resumed = await replayJournal({ sessionID, location, engineID: "store", after: 1, request })
  // One committed assistant row now settles text plus the step's usage evidence.
  expect(resumed.events).toHaveLength(2)
  expect(resumed.events[0]).toEqual(full.events[2])
  expect(resumed.cursor).toBe(2)
  const wire = await Effect.runPromise(
    Schema.encodeEffect(SessionEvent.Durable)(
      Schema.decodeUnknownSync(Schema.toType(SessionEvent.Durable))(resumed.events[0]),
    ),
  )
  expect(JSON.stringify(wire)).toContain('"text":"second"')
})

test("SSE advances past non-projecting rows and sees later commits without a handoff gap", async () => {
  const event = (
    await replayJournal({
      sessionID,
      location,
      engineID: "store",
      after: 0,
      request: async (method) => (method === "snapshot" ? { session_id: sessionID, cursor: 1 } : [row(1, "later")]),
    })
  ).events[0]
  const cursors: number[] = []
  const stream = nativeSessionEvents(
    {
      events: (input) =>
        Effect.sync(() => {
          cursors.push(input.after)
          return cursors.length === 1 ? { events: [], cursor: 5 } : { events: [event], cursor: 6 }
        }),
    },
    { sessionID, location, storage: AbsolutePath.make("/tmp/store"), after: 0 },
  )
  const values = await Effect.runPromise(stream.pipe(Stream.take(1), Stream.runCollect))
  expect(values).toHaveLength(1)
  expect(cursors).toEqual([0, 5])
})

test("history pages skip unprojected rows and keep a native sequence group intact", async () => {
  const journal = [
    { session_id: sessionID, seq: 1, kind: "context.changed", data: {} },
    {
      ...row(2, "first"),
      data: {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    },
    row(3, "last"),
    { session_id: sessionID, seq: 4, kind: "context.changed", data: {} },
  ]
  const request = async (method: string) => (method === "snapshot" ? { session_id: sessionID, cursor: 4 } : journal)
  const first = await replayJournal({ sessionID, location, engineID: "store", after: 0, limit: 1, request })
  expect(first.events).toHaveLength(3)
  expect(first.cursor).toBe(2)
  expect(first.hasMore).toBe(true)
  const second = await replayJournal({ sessionID, location, engineID: "store", after: first.cursor, limit: 1, request })
  expect(second.events).toHaveLength(2)
  expect(second.hasMore).toBe(false)
  expect(second.events[0].id).not.toBe(first.events[0].id)
  const end = await replayJournal({ sessionID, location, engineID: "store", after: 4, limit: 1, request })
  expect(end.events).toEqual([])
  expect(end.hasMore).toBe(false)
})

test("reconnecting after a tool call reconstructs its prefix before translating completion", async () => {
  const journal = [
    {
      session_id: sessionID,
      seq: 1,
      kind: "message.committed",
      recorded_at_ms: 400,
      data: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
    },
    { session_id: sessionID, seq: 2, kind: "context.changed", data: {} },
    {
      session_id: sessionID,
      seq: 3,
      kind: "tool.completed",
      recorded_at_ms: 420,
      data: { call_id: "c1", result: "contents", is_error: false },
    },
  ]
  const page = await replayJournal({
    sessionID,
    location,
    engineID: "store",
    after: 2,
    limit: 1,
    request: async (method) => (method === "snapshot" ? { session_id: sessionID, cursor: 3 } : journal),
  })
  expect(page.events).toHaveLength(1)
  expect(page.events[0].type).toBe("session.next.tool.success")
  const data = page.events[0].data as { assistantMessageID?: unknown }
  expect(String(data.assistantMessageID)).toBe("msg_ses_journal_1")
})

test("a discontinuous journal fails instead of silently truncating replay", async () => {
  await expect(
    replayJournal({
      sessionID,
      location,
      engineID: "store",
      after: 0,
      request: async (method) => (method === "snapshot" ? { session_id: sessionID, cursor: 2 } : [row(2, "gap")]),
    }),
  ).rejects.toThrow("discontinuous")
})

test("caught-up idle polling does not reread a long journal", async () => {
  const methods: string[] = []
  const page = await replayJournal({
    sessionID,
    location,
    engineID: "store",
    after: 2500,
    request: async (method) => {
      methods.push(method)
      if (method !== "snapshot") throw new Error("idle poll reread the journal")
      return { session_id: sessionID, cursor: 2500 }
    },
  })
  expect(methods).toEqual(["snapshot"])
  expect(page).toEqual({ events: [], cursor: 2500, hasMore: false })
})
