import { describe, expect, it } from "bun:test"
import { Cron } from "@miao/core/session/cron"

/** A local-time epoch, so expectations share the parser's time zone. */
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second, 0).getTime()

const after = (expression: string, fromMillis: number) => Cron.next(expression, fromMillis)

describe("Cron.parse", () => {
  it("accepts every documented field form", () => {
    for (const expression of [
      "* * * * *",
      "5 0 * * *",
      "0 9-17 * * *",
      "*/15 * * * *",
      "0-30/10 * * * *",
      "0,30 * * * *",
      "0 0 1,15 * *",
      "0 0 1 1-6/2 *",
    ]) {
      expect(Cron.parse(expression)).not.toBeInstanceOf(Cron.ParseError)
    }
  })

  it("rejects a bad field with a typed error instead of throwing", () => {
    expect(Cron.parse("nope")).toBeInstanceOf(Cron.ParseError)
    expect(Cron.parse("60 * * * *")).toBeInstanceOf(Cron.ParseError)
    expect(Cron.parse("5-2 * * * *")).toBeInstanceOf(Cron.ParseError)
    expect(Cron.parse("* * * *")).toBeInstanceOf(Cron.ParseError)
    expect(Cron.parse("1,,2 * * * *")).toBeInstanceOf(Cron.ParseError)
    expect((Cron.parse("60 * * * *") as Cron.ParseError).message).toContain("out of range")
  })

  it("normalizes Sunday 7 to Sunday 0", () => {
    const parsed = Cron.parse("0 0 * * 7")
    expect(parsed).not.toBeInstanceOf(Cron.ParseError)
    expect((parsed as Cron.Parsed).dayOfWeek).toEqual([0])
    expect((Cron.parse("0 0 * * 0") as Cron.Parsed).dayOfWeek).toEqual([0])
    // A range ending at 7 still includes Sunday.
    expect((Cron.parse("0 0 * * 5-7") as Cron.Parsed).dayOfWeek).toEqual([0, 5, 6])
  })
})

describe("Cron.next", () => {
  it("returns the next minute strictly after the given time", () => {
    expect(after("* * * * *", local(2026, 1, 1, 10, 0, 0))).toBe(local(2026, 1, 1, 10, 1, 0))
    expect(after("* * * * *", local(2026, 1, 1, 10, 0, 30))).toBe(local(2026, 1, 1, 10, 1, 0))
  })

  it("honors single numbers, ranges, steps, and lists", () => {
    expect(after("0 0 * * *", local(2026, 1, 1, 10, 0))).toBe(local(2026, 1, 2, 0, 0))
    expect(after("0 9-17 * * *", local(2026, 1, 1, 8, 0))).toBe(local(2026, 1, 1, 9, 0))
    expect(after("*/15 * * * *", local(2026, 1, 1, 10, 7))).toBe(local(2026, 1, 1, 10, 15))
    expect(after("0-30/10 * * * *", local(2026, 1, 1, 10, 5))).toBe(local(2026, 1, 1, 10, 10))
    expect(after("0,30 * * * *", local(2026, 1, 1, 10, 5))).toBe(local(2026, 1, 1, 10, 30))
    expect(after("0,30 * * * *", local(2026, 1, 1, 10, 35))).toBe(local(2026, 1, 1, 11, 0))
  })

  it("rolls into the next month and year", () => {
    expect(after("0 0 1 6 *", local(2026, 1, 15))).toBe(local(2026, 6, 1, 0, 0))
    expect(after("0 0 1 1 *", local(2026, 3, 5))).toBe(local(2027, 1, 1, 0, 0))
  })

  it("matches Sunday for both 0 and 7", () => {
    // 2026-01-05 is a Monday; the next Sunday is 2026-01-11.
    expect(after("0 0 * * 0", local(2026, 1, 5))).toBe(local(2026, 1, 11, 0, 0))
    expect(after("0 0 * * 7", local(2026, 1, 5))).toBe(local(2026, 1, 11, 0, 0))
  })

  it("applies the day-of-month/day-of-week OR rule when both are restricted", () => {
    // Day 15 or Monday: the first Monday after 2026-01-01 is 2026-01-05.
    expect(after("0 0 15 * 1", local(2026, 1, 1))).toBe(local(2026, 1, 5, 0, 0))
    // From 2026-01-13, day 15 comes before the next Monday (2026-01-19).
    expect(after("0 0 15 * 1", local(2026, 1, 13, 1))).toBe(local(2026, 1, 15, 0, 0))
  })

  it("uses only the restricted day field when the other is *", () => {
    expect(after("0 0 15 * *", local(2026, 1, 5))).toBe(local(2026, 1, 15, 0, 0))
    // 2026-01-12 is a Monday; day-of-week alone governs.
    expect(after("0 0 * * 1", local(2026, 1, 6))).toBe(local(2026, 1, 12, 0, 0))
  })

  it("returns undefined for an impossible expression instead of hanging", () => {
    expect(after("0 0 31 2 *", local(2026, 1, 1))).toBeUndefined()
  })

  it("returns undefined for an unparseable expression", () => {
    expect(after("not cron", local(2026, 1, 1))).toBeUndefined()
  })
})
