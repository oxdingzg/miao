import { describe, expect, test } from "bun:test"
import { ContextNotice } from "@miao/core/session/context-notice"

describe("ContextNotice.notice", () => {
  test("stays silent below the threshold", () => {
    expect(ContextNotice.notice({ observedTokens: 690, context: 1000, announced: 0 })).toBeUndefined()
    expect(ContextNotice.notice({ observedTokens: 0, context: 1000, announced: 0 })).toBeUndefined()
    expect(ContextNotice.notice({ observedTokens: 700, context: 0, announced: 0 })).toBeUndefined()
  })

  test("announces on first crossing and reports the rounded percent", () => {
    const notice = ContextNotice.notice({ observedTokens: 712, context: 1000, announced: 0 })
    expect(notice?.announce).toBe(true)
    expect(notice?.band).toBe(0.7)
    expect(notice?.percent).toBe(71)
    expect(notice?.observed).toBe(712)
  })

  test("announces once per 10% band", () => {
    expect(ContextNotice.notice({ observedTokens: 749, context: 1000, announced: 0.7 })).toBeUndefined()
    const next = ContextNotice.notice({ observedTokens: 801, context: 1000, announced: 0.7 })
    expect(next?.band).toBe(0.8)
    expect(next?.percent).toBe(80)
  })

  test("floating point drift does not skip or repeat a band", () => {
    // 0.7 + 0.1 in floats is 0.7999999999999999; floor still lands on 0.7.
    expect(ContextNotice.notice({ observedTokens: 799, context: 1000, announced: 0.7 })).toBeUndefined()
    expect(ContextNotice.notice({ observedTokens: 801, context: 1000, announced: 0.7 })?.band).toBe(0.8)
  })
})

describe("ContextNotice.usage", () => {
  test("stays empty without a real number on both sides", () => {
    expect(ContextNotice.usage(0, 1000)).toBe("")
    expect(ContextNotice.usage(500, 0)).toBe("")
    expect(ContextNotice.usage(-1, 1000)).toBe("")
  })

  test("reports the rounded percent with both token counts", () => {
    expect(ContextNotice.usage(237993, 1_000_000)).toBe(
      "Context status: about 24% of the model context window is in use (237993 of 1000000 tokens).",
    )
    expect(ContextNotice.usage(712, 1000)).toContain("about 71%")
  })
})
