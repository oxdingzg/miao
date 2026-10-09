import { expect, test } from "bun:test"
import type { Part } from "@miao/schema/view-models"
import { parseSessionMessage, sessionMessageEntries } from "../src/util/session-message"

const id = "ses_f0eaecb6affeBw57SfwTo74Ohs"

test("unwraps the canonical inter-session envelope for display only", () => {
  const body = "## 调查结论\n\n- **原因**：同步延迟\n- 修复 `sync.tsx`\n\n```ts\nawait refresh()\n```"
  const text = `<message from session="${id}">\n${body}\n</message>`
  expect(parseSessionMessage(text)).toEqual({ sessionID: id, body })
  expect(text).toBe(`<message from session="${id}">\n${body}\n</message>`)
})

test("preserves body indentation, blank lines, code and quoted message tags", () => {
  const body = '  indented\n\n```xml\n<message from session="ses_other">\nquoted\n</message>\n```\n\n'
  expect(parseSessionMessage(`<message from session="${id}">\n${body}\n</message>`)?.body).toBe(body)
})

test("accepts CRLF framing without adding a carriage return to the body", () => {
  const body = "第一段\r\n\r\n第二段"
  expect(parseSessionMessage(`<message from session="${id}">\r\n${body}\r\n</message>`)).toEqual({
    sessionID: id,
    body,
  })
})

test("ordinary user text and incomplete or quoted envelopes stay unmodified", () => {
  const text = `<message from session="${id}">\nhello\n</message>`
  for (const input of [
    "ordinary user question",
    `Explain this:\n${text}`,
    `${text}\nMore text`,
    `\`\`\`xml\n${text}\n\`\`\``,
    `<message from session="${id}">\nhello`,
    '<message from session="not-a-session">\nhello\n</message>',
    '<message from session="ses_other" trusted="true">\nhello\n</message>',
  ]) {
    expect(parseSessionMessage(input)).toBeUndefined()
  }
})

test("empty bodies retain their sender", () => {
  expect(parseSessionMessage(`<message from session="${id}">\n\n</message>`)).toEqual({ sessionID: id, body: "" })
})

test("derives inbound and completed outbound messages from the transcript in order", () => {
  const parts: Record<string, ReadonlyArray<Part>> = {
    msg_user: [
      {
        id: "prt_in",
        sessionID: "ses_self",
        messageID: "msg_user",
        type: "text",
        text: `<message from session="${id}">\nhello there\n</message>`,
      } as Part,
    ],
    msg_sent: [
      {
        id: "prt_out",
        sessionID: "ses_self",
        messageID: "msg_sent",
        type: "tool",
        callID: "call_1",
        tool: "send_message",
        state: {
          status: "completed",
          input: { to: "@peer", message: "first line\nsecond line" },
          output: "",
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        },
      } as Part,
      // A running call has not been delivered, so it stays out of the summary.
      {
        id: "prt_running",
        sessionID: "ses_self",
        messageID: "msg_sent",
        type: "tool",
        callID: "call_2",
        tool: "send_message",
        state: { status: "running", input: { to: "@pending", message: "not yet" }, time: { start: 0 } },
      } as Part,
    ],
  }
  const entries = sessionMessageEntries(
    [
      { id: "msg_user", role: "user" },
      { id: "msg_sent", role: "assistant" },
    ],
    (messageID) => parts[messageID] ?? [],
  )
  expect(entries).toEqual([
    { id: "prt_in", direction: "in", peer: id, body: "hello there" },
    { id: "prt_out", direction: "out", peer: "@peer", body: "first line\nsecond line" },
  ])
})
