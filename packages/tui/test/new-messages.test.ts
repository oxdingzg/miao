import { expect, test } from "bun:test"
import { messagesAfter } from "../src/routes/session/new-messages"

const messages = [{ id: "a" }, { id: "b" }, { id: "c" }]

test("counts only the messages that arrived after the reader left the tail", () => {
  expect(messagesAfter(messages, "a")).toBe(2)
  expect(messagesAfter(messages, "c")).toBe(0)
})

test("an unmarked reader is not reading behind anything", () => {
  expect(messagesAfter(messages, undefined)).toBe(0)
})

test("a lost mark counts every visible message as unseen", () => {
  expect(messagesAfter(messages, "gone")).toBe(3)
})
