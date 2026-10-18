import { expect, test } from "bun:test"
import { EngineTranslator, type EngineSessionEvent } from "../../src/engine/session"
import { engineMessageSequence } from "../../src/engine/message-sequence"
import { SessionMessage } from "@miao/schema/session-message"

test("synthetic context projects as injected history with stable replay and fork-cut identity", () => {
  const event = {
    session_id: "ses_injected",
    seq: 7,
    recorded_at_ms: 1000,
    kind: "message.synthetic",
    data: { input_id: "injected-key", text: "skill body", source: "skill:fixture" },
  }
  const live: EngineSessionEvent[] = []
  const replay: EngineSessionEvent[] = []
  new EngineTranslator((item) => live.push(item)).dispatch(event)
  new EngineTranslator((item) => replay.push(item)).dispatch(event)
  expect(live).toEqual(replay)
  expect(live).toHaveLength(1)
  expect(live[0]).toMatchObject({
    type: "session.next.synthetic",
    data: { text: "skill body", messageID: "msg_ses_injected_7", metadata: { source: "skill:fixture" } },
    source: { sessionID: "ses_injected", seq: 7, index: 0, recordedAtMs: 1000 },
  })
  expect(engineMessageSequence("ses_injected", SessionMessage.ID.make("msg_ses_injected_7"), [event])).toBe(7)
})
