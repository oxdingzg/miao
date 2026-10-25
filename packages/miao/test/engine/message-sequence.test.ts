import { expect, test } from "bun:test"
import { SessionMessage } from "@miao/schema/session-message"
import { generatedInputMessageID, messageID } from "@/engine/identity"
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
  // A submitted prompt is never aliased by the seq-shaped id at its promotion:
  // that shape names another (assistant) message.
  expect(engineMessageSequence(session, messageID(session, 4), events)).toBeUndefined()
})

test("a generated notice resolves under its derived and its legacy identity", () => {
  const generated = [
    { session_id: session, seq: 5, kind: "input.promoted", data: { input_id: "monitor:job:u", prompt: "notice" } },
  ]
  expect(engineMessageSequence(session, generatedInputMessageID("monitor:job:u"), generated)).toBe(5)
  // Clients and persisted drafts created before the derived identity still
  // address the notice by the promotion seq.
  expect(engineMessageSequence(session, messageID(session, 5), generated)).toBe(5)
})
