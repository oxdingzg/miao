import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../src/session-message"

test("interruption is optional, structured, and backward-compatible on unknown errors", () => {
  expect(Schema.decodeUnknownSync(SessionMessage.UnknownError)({ type: "unknown", message: "Legacy error" })).toEqual({
    type: "unknown",
    message: "Legacy error",
  })
  expect(
    Schema.encodeSync(SessionMessage.UnknownError)({ type: "unknown", message: "Failed", interrupted: undefined }),
  ).toEqual({
    type: "unknown",
    message: "Failed",
  })
  expect(
    Schema.decodeUnknownSync(SessionMessage.UnknownError)({ type: "unknown", message: "Stopped", interrupted: true })
      .interrupted,
  ).toBe(true)
  expect(() =>
    Schema.decodeUnknownSync(SessionMessage.UnknownError)({ type: "unknown", message: "Stopped", interrupted: "true" }),
  ).toThrow()
})
