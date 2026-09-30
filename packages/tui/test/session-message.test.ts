import { expect, test } from "bun:test"
import { parseSessionMessage } from "../src/util/session-message"

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
