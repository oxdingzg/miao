import { expect, test } from "bun:test"
import { SessionMessage } from "@miao/schema/session-message"
import { engineMessageSequence } from "@/engine/message-sequence"

const session = "ses_native_boundary"
const events = [
  { session_id: session, seq: 4, kind: "input.promoted", data: { input_id: "msg_custom_prompt", prompt: "request" } },
  { session_id: session, seq: 7, kind: "provider.started", data: {} },
  { session_id: session, seq: 11, kind: "message.committed", data: { role: "assistant", anchor_seq: 7, content: [] } },
]

test("native boundaries distinguish a streaming anchor from a committed message sequence", () => {
  expect(engineMessageSequence(session, SessionMessage.ID.make("msg_custom_prompt"), events)).toBe(4)
  expect(engineMessageSequence(session, SessionMessage.ID.make(`msg_${session}_7`), events)).toBe(11)
  expect(engineMessageSequence(session, SessionMessage.ID.make(`msg_${session}_11`), events)).toBeUndefined()
  expect(engineMessageSequence("ses_other", SessionMessage.ID.make("msg_custom_prompt"), events)).toBeUndefined()
  expect(engineMessageSequence(session, SessionMessage.ID.make("msg_missing"), events)).toBeUndefined()
})
