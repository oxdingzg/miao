import { expect, test } from "bun:test"
import { parseTodos } from "../src/routes/session/index"

// Stray carriage returns used to rewind the terminal cursor, shredding the
// todo panel into one word per line. The transcript renders the raw tool input,
// so its parser normalises the same way the durable state does.
test("transcript todos drop carriage returns and collapse runs", () => {
  const todos = parseTodos([
    {
      id: "migrate\r-drill",
      content: "P2\r-3\r migrate\r-back\r：PR\r \r#1219\r（clippy\r/rustfmt\r 已清）",
      status: "in_progress",
      priority: "high",
      depends_on: ["ci\r run"],
    },
  ])
  expect(todos).toEqual([
    {
      id: "migrate-drill",
      content: "P2-3 migrate-back：PR #1219（clippy/rustfmt 已清）",
      status: "in_progress",
      depends_on: ["ci run"],
    },
  ])
})

test("a todo that is only control characters is dropped", () => {
  expect(parseTodos([{ content: "\r\r", status: "pending", priority: "low" }])).toEqual([])
})
