import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Location } from "@miao/schema/location"
import { translateMessage, translatePrompt, translateTools } from "@/engine/bridge"
import { clientEvent } from "@/engine/event"
import type { EngineEvent } from "@/engine/client"

const location = Schema.decodeUnknownSync(Location.Ref)({ directory: "/tmp/engine-recorded-time" })
const committed = {
  session_id: "ses_time",
  seq: 12,
  kind: "message.committed",
  recorded_at_ms: 1_700_000_000_123,
  data: {
    role: "assistant",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "tool_use", id: "call_time", name: "read_file", input: { path: "file.txt" } },
    ],
  },
} satisfies EngineEvent

test("replayed assistant text and tool calls retain the source commit time", () => {
  const first = [...translateMessage(committed), ...translateTools(committed)]
  const replay = [...translateMessage({ ...committed }), ...translateTools({ ...committed })]
  expect(first).toHaveLength(3)
  expect(replay).toEqual(first)
  expect(first.map((item) => DateTime.toEpochMillis(item.timestamp))).toEqual([
    committed.recorded_at_ms,
    committed.recorded_at_ms,
    committed.recorded_at_ms,
  ])
})

test("promotion retains its stored timestamp including UNIX epoch zero", () => {
  const prompt = translatePrompt({
    ...committed,
    kind: "input.promoted",
    recorded_at_ms: 0,
    data: { input_id: "in_time", prompt: "hello" },
  })
  if (!prompt) throw new Error("missing prompt")
  expect(DateTime.toEpochMillis(prompt.timestamp)).toBe(0)
})

test("delivery retains nullable recording provenance without changing cursor identity", async () => {
  const output = {
    type: "session.next.text.ended",
    data: translateMessage(committed)[0],
    source: { sessionID: committed.session_id, seq: committed.seq, index: 0 },
  }
  const values = await Effect.runPromise(
    Effect.all(
      [committed.recorded_at_ms, 0, null, undefined].map((recordedAtMs) =>
        clientEvent({ ...output, source: { ...output.source, recordedAtMs } }, { engineID: "store-time", location }),
      ),
    ),
  )
  expect(values.map((item) => item.metadata?.engine)).toEqual(
    [committed.recorded_at_ms, 0, null, null].map((recorded_at_ms) => ({
      id: "store-time",
      session_id: committed.session_id,
      seq: committed.seq,
      index: 0,
      recorded_at_ms,
    })),
  )
  expect(new Set(values.map((item) => item.id)).size).toBe(1)
  expect(values.every((item) => item.durable === undefined)).toBe(true)
})
