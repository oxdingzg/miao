import { describe, expect, test } from "bun:test"
import { create, timestamp } from "../src/identifier"

// Legacy identifiers wrapped every 2^36 ms.
const wrap = 2 ** 36
const wraps = [25 * wrap, 26 * wrap, 27 * wrap]

// Times in creation order: around past and future legacy wrap points, then the far future.
const times = [
  wraps[0] + 1,
  wraps[1] - 1,
  wraps[1],
  wraps[1] + 1,
  Date.UTC(2026, 9, 1),
  wraps[2] - 1,
  wraps[2],
  wraps[2] + 1,
  Date.UTC(3000, 0, 1),
  Date.UTC(9999, 11, 31),
  2 ** 48 - 1,
]

// Bodies produced by the legacy 48-bit format, without the `prefix_`.
const legacy = [
  // 2026-08-14T11:19:55.135Z, the last millisecond before the wrap.
  "ffffffffffff" + "zzzzzzzzzzzzzz",
  "fffffffff001" + "AbCdEfGhIjKlMn",
  // 2026-08-14T11:19:55.136Z, the first millisecond after the wrap.
  "000000000001" + "00000000000000",
  // 2026-10-01, the current post-wrap range.
  "0f1a2b3c4d5e" + "ZyXwVuTsRqPoNm",
  // 2028-10-17, just before the next wrap.
  "fffffffff001" + "zzzzzzzzzzzzzz",
]

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

describe("identifier", () => {
  test("keeps 26 alphanumeric characters", () => {
    const ids = times.flatMap((time) => [create(false, time), create(true, time)])
    expect(ids.filter((id) => !/^[0-9A-Za-z]{26}$/.test(id))).toEqual([])
  })

  test("ascending order follows creation across legacy wrap points", () => {
    const ids = times.map((time) => create(false, time))
    expect(ids.toSorted(byCodeUnit)).toEqual(ids)
    expect(ids.toSorted((a, b) => a.localeCompare(b))).toEqual(ids)
  })

  test("ascending order follows creation within one millisecond", () => {
    const ids = Array.from({ length: 100 }, () => create(false, wraps[1]))
    expect(ids.toSorted(byCodeUnit)).toEqual(ids)
  })

  test("descending order reverses creation across legacy wrap points", () => {
    const ids = times.map((time) => create(true, time))
    expect(ids.toSorted(byCodeUnit)).toEqual(ids.toReversed())
    expect(ids.toSorted((a, b) => a.localeCompare(b))).toEqual(ids.toReversed())
  })

  test("new ascending identifiers sort after every legacy identifier", () => {
    const ids = [Date.UTC(2026, 9, 1), wraps[2] + 1].map((time) => create(false, time))
    expect([...ids, ...legacy].toSorted(byCodeUnit).slice(-ids.length)).toEqual(ids)
    expect([...ids, ...legacy].toSorted((a, b) => a.localeCompare(b)).slice(-ids.length)).toEqual(ids)
  })

  test("timestamp round trips new identifiers", () => {
    expect(times.map((time) => timestamp(create(false, time)))).toEqual(times)
  })

  test("timestamp decodes legacy identifiers modulo the wrap", () => {
    expect(timestamp(legacy[0])).toBe(wrap - 1)
    expect(timestamp(legacy[2])).toBe(0)
  })
})
