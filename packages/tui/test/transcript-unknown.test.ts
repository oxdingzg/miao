import { expect, test } from "bun:test"
import { formatAssistantHeader, formatTranscript } from "../src/util/transcript"
import { chronological } from "../src/util/message-order"
import { testAssistantMessage, testTextPart } from "./lib/v2-message"

test("transcript displays unknown identity without inventing a duration", () => {
  const message = testAssistantMessage({ created: 0, completed: 1000 })
  expect(
    formatAssistantHeader({ ...message, agent: null, model: null, time: { created: null, completed: 1000 } }, true),
  ).toBe("## Assistant (Unknown agent · Unknown model)\n\n")
  expect(formatAssistantHeader(message, true)).toContain("1.0s")
})

test("a missing historical clock retains source order throughout transcript rendering", () => {
  const messages = [
    testAssistantMessage({ id: "msg_later", created: 9000, content: [testTextPart("first", "FIRST_OBSERVED")] }),
    {
      ...testAssistantMessage({ id: "msg_unknown", content: [testTextPart("unknown", "UNKNOWN_CLOCK")] }),
      time: { created: null },
    },
    testAssistantMessage({ id: "msg_earlier", created: 0, content: [testTextPart("last", "LAST_OBSERVED")] }),
  ]
  const transcript = formatTranscript(
    { id: "ses_unknown", title: "History", time: { created: 0, updated: 1000 } },
    messages,
    { thinking: true, toolDetails: true, assistantMetadata: false },
  )
  expect(transcript.indexOf("FIRST_OBSERVED")).toBeLessThan(transcript.indexOf("UNKNOWN_CLOCK"))
  expect(transcript.indexOf("UNKNOWN_CLOCK")).toBeLessThan(transcript.indexOf("LAST_OBSERVED"))
  expect(messages.map((message) => message.id)).toEqual(["msg_later", "msg_unknown", "msg_earlier"])
})

test("known epoch-zero history still sorts chronologically with deterministic ties", () => {
  const messages = [
    { id: "late", time: { created: 1000 } },
    { id: "b", time: { created: 0 } },
    { id: "a", time: { created: 0 } },
  ]
  expect(chronological(messages).map((message) => message.id)).toEqual(["a", "b", "late"])
})
