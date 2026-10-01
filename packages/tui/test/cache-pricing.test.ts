import { describe, expect, test } from "bun:test"
import { isOffPeak, isTimeOfDayPriced, priceMultiplier } from "../src/util/cache-pricing"

// 2026-10-01 is a Thursday, so day 3 is Saturday and day 4 is Sunday. Beijing
// is UTC+8, which is the offset the schedule is defined in.
const beijing = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 8, minute)

describe("isOffPeak", () => {
  test("counts both weekday windows as peak", () => {
    expect(isOffPeak(beijing(1, 9))).toBe(false)
    expect(isOffPeak(beijing(1, 11, 59))).toBe(false)
    expect(isOffPeak(beijing(1, 14))).toBe(false)
    expect(isOffPeak(beijing(1, 17, 59))).toBe(false)
  })

  test("counts each window's closing edge as off-peak", () => {
    expect(isOffPeak(beijing(1, 8, 59))).toBe(true)
    expect(isOffPeak(beijing(1, 12))).toBe(true)
    expect(isOffPeak(beijing(1, 13))).toBe(true)
    expect(isOffPeak(beijing(1, 18))).toBe(true)
  })

  test("counts the night as off-peak", () => {
    expect(isOffPeak(beijing(1, 23))).toBe(true)
    expect(isOffPeak(beijing(1, 3))).toBe(true)
  })

  test("counts a whole weekend as off-peak, including peak-window hours", () => {
    expect(isOffPeak(beijing(3, 10))).toBe(true)
    expect(isOffPeak(beijing(4, 15))).toBe(true)
  })

  test("reads the clock in the requested timezone, not the host's", () => {
    // 09:00 Beijing is 01:00 UTC, which is outside the windows when read as UTC.
    expect(isOffPeak(beijing(1, 9))).toBe(false)
    expect(isOffPeak(beijing(1, 9), "UTC")).toBe(true)
  })
})

describe("priceMultiplier", () => {
  test("halves DeepSeek off-peak and leaves its peak rate alone", () => {
    expect(priceMultiplier(beijing(1, 9), "deepseek", "deepseek-chat")).toBe(1)
    expect(priceMultiplier(beijing(1, 13), "deepseek", "deepseek-chat")).toBe(0.5)
  })

  test("leaves a flat-rate provider alone at every hour", () => {
    expect(priceMultiplier(beijing(1, 9), "anthropic", "claude-sonnet-5-5")).toBe(1)
    expect(priceMultiplier(beijing(1, 13), "anthropic", "claude-sonnet-5-5")).toBe(1)
  })

  test("finds DeepSeek through a gateway only when the id or the overrides say so", () => {
    expect(priceMultiplier(beijing(1, 13), "tencent", "deepseek-chat")).toBe(1)
    expect(priceMultiplier(beijing(1, 13), "tencent", "deepseek/deepseek-chat")).toBe(0.5)
    expect(priceMultiplier(beijing(1, 13), "tencent", "deepseek-chat", { providers: ["tencent"] })).toBe(0.5)
  })

  test("matches an override without regard to case", () => {
    expect(priceMultiplier(beijing(1, 13), "Tencent", "glm-4", { providers: ["tencent"] })).toBe(0.5)
  })
})

describe("isTimeOfDayPriced", () => {
  test("holds for DeepSeek and not for a flat-rate provider", () => {
    expect(isTimeOfDayPriced("deepseek", "deepseek-chat")).toBe(true)
    expect(isTimeOfDayPriced("anthropic", "claude-sonnet-5-5")).toBe(false)
  })
})
