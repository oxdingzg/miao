import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionRecallWindow } from "../src/groups/session"

const window = {
  toolUseID: "call_1",
  messageSeq: 12,
  isError: false,
  offset: 0,
  text: "restored bytes",
  totalBytes: 14,
  truncated: false,
}

describe("SessionRecallWindow", () => {
  test("accepts a complete window and leaves nextOffset optional", async () => {
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(SessionRecallWindow)(window))).toEqual(window)
    expect(
      await Effect.runPromise(Schema.decodeUnknownEffect(SessionRecallWindow)({ ...window, truncated: true, nextOffset: 32768 })),
    ).toEqual({ ...window, truncated: true, nextOffset: 32768 })
  })

  test("rejects a window without the restored text", async () => {
    const { text: _text, ...withoutText } = window
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(SessionRecallWindow)(withoutText))).rejects.toThrow()
  })

  test("rejects a negative offset", async () => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(SessionRecallWindow)({ ...window, offset: -1 })),
    ).rejects.toThrow()
  })
})
