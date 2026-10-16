import { describe, expect, test } from "bun:test"
import { createTimeFormatter } from "./time"

const now = Date.parse("2026-10-16T12:00:00Z")

describe("message and session times", () => {
  test("same-day messages use time; older days and years remain distinguishable", () => {
    const format = createTimeFormatter("en-GB", "UTC")
    expect(format.compact(now, now)).toBe("12:00")
    expect(format.compact(Date.parse("2026-10-15T12:00:00Z"), now)).toContain("15/10")
    expect(format.compact(Date.parse("2025-10-16T12:00:00Z"), now)).toContain("2025")
  })

  test("day boundaries follow the display timezone, not the server or UTC day", () => {
    const format = createTimeFormatter("en-GB", "Asia/Shanghai")
    const midnight = Date.parse("2026-10-16T16:00:00Z")
    expect(format.compact(midnight - 60_000, midnight)).toContain("16/10")
    expect(format.compact(midnight, midnight)).toBe("00:00")
  })

  test("precise times disambiguate repeated DST hours with offsets", () => {
    const format = createTimeFormatter("en-GB", "America/New_York")
    const first = format.precise(Date.parse("2026-11-01T05:30:15Z"))
    const second = format.precise(Date.parse("2026-11-01T06:30:15Z"))
    expect(first).toContain("01:30:15")
    expect(second).toContain("01:30:15")
    expect(first).toContain("GMT-04:00")
    expect(second).toContain("GMT-05:00")
  })

  test("unknown and invalid historical times never become now or epoch", () => {
    const format = createTimeFormatter("en-GB", "UTC")
    for (const input of [null, undefined, NaN, Infinity, 9e15]) {
      expect(format.compact(input, now)).toBe("—")
      expect(format.precise(input)).toBe("—")
      expect(format.relative(input, now)).toBe("—")
    }
    expect(format.precise(0)).toContain("1970")
  })

  test("session ages use short relative labels then a stable date", () => {
    const format = createTimeFormatter("en-GB", "UTC")
    expect(format.relative(now - 5 * 60_000, now)).toMatch(/^5 min\.? ago$/)
    expect(format.relative(now - 2 * 3_600_000, now)).toMatch(/^2 hr\.? ago$/)
    expect(format.relative(now - 8 * 86_400_000, now)).toContain("2026")
    expect(format.relative(now + 60_000, now)).toBe(format.relative(now, now))
  })

  test("formatters are shared and locale clock preferences are respected", () => {
    expect(createTimeFormatter("en-GB", "UTC")).toBe(createTimeFormatter("en-GB", "UTC"))
    expect(createTimeFormatter("en-US", "UTC").compact(now, now)).toContain("PM")
    expect(createTimeFormatter("ar-EG", "UTC").compact(now, now)).toMatch(/[٠-٩]/)
  })
})
