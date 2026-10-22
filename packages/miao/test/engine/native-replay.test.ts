import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Location } from "@miao/schema/location"
import { SessionMessage } from "@miao/schema/session-message"
import { DateTime as EffectDateTime } from "effect"
import { translateCompaction, translateReasoning } from "@/engine/bridge"
import type { EngineEvent } from "@/engine/client"

const location = Schema.decodeUnknownSync(Location.Ref)({ directory: "/tmp/engine-native-replay" })

const reasoningCommitted = {
  session_id: "ses_replay",
  seq: 30,
  kind: "message.committed",
  recorded_at_ms: 1_700_000_030_123,
  data: {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "considering the edge cases",
        signature: "sig-1",
      },
      { type: "text", text: "answer" },
    ],
  },
} satisfies EngineEvent

test("replayed reasoning blocks project as reasoning.ended with stable ids", () => {
  const events = translateReasoning(reasoningCommitted)
  expect(events).toHaveLength(1)
  const event = events[0]!
  expect(String(event.sessionID)).toBe("ses_replay")
  expect(typeof event.assistantMessageID).toBe("string")
  expect(event.reasoningID.startsWith("reasoning_")).toBe(true)
  expect(event.reasoningID).toContain("_0")
  expect(event.text).toBe("considering the edge cases")
  expect(event.timestamp != null).toBe(true)
})

test("non-reasoning commits project no reasoning.ended events", () => {
  const textOnly = {
    ...reasoningCommitted,
    data: { role: "assistant", content: [{ type: "text", text: "plain" }] },
  } satisfies EngineEvent
  expect(translateReasoning(textOnly)).toEqual([])
  const user = {
    ...reasoningCommitted,
    seq: 31,
    data: { role: "user", content: [{ type: "text", text: "hi" }] },
  } satisfies EngineEvent
  expect(translateReasoning(user)).toEqual([])
})

const preCompact = {
  session_id: "ses_replay",
  seq: 40,
  kind: "pre_compact",
  recorded_at_ms: 1_700_000_040_123,
  data: { compaction_id: "cmp_1" },
} satisfies EngineEvent

const postCompact = {
  session_id: "ses_replay",
  seq: 41,
  kind: "post_compact",
  recorded_at_ms: 1_700_000_041_123,
  data: { compaction_id: "cmp_1" },
} satisfies EngineEvent

test("compaction lifecycle projects as started/ended with a stable message id", () => {
  const started = translateCompaction(preCompact)
  expect(started).toEqual({ type: "session.next.compaction.started", data: { status: "compacting context" } })
  const ended = translateCompaction(postCompact)
  if (!ended || ended.type !== "session.next.compaction.ended") throw new Error("wrong projection")
  expect(String(ended.data.messageID)).toBe("msg_compaction_cmp_1")
  expect(ended.data.reason).toBe("auto")
})

test("non-compaction events and anonymous compactions project nothing", () => {
  expect(translateCompaction(reasoningCommitted)).toBeUndefined()
  expect(
    translateCompaction({
      ...postCompact,
      data: {},
    }),
  ).toBeUndefined()
})
