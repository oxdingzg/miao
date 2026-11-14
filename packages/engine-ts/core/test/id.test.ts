import { describe, expect, test } from "bun:test"
import { Identifier } from "../src/id/id"

const wrap = 2 ** 36
const times = [26 * wrap - 1, 26 * wrap, Date.UTC(2026, 9, 1), 27 * wrap - 1, 27 * wrap, Date.UTC(3000, 0, 1)]

describe("Identifier", () => {
  test("prefixed IDs keep creation order across legacy wrap points", () => {
    const ascending = times.map((time) => Identifier.create("msg", "ascending", time))
    const descending = times.map((time) => Identifier.create("ses", "descending", time))
    expect(ascending.toSorted()).toEqual(ascending)
    expect(descending.toSorted()).toEqual(descending.toReversed())
  })

  test("new IDs sort after legacy post-wrap IDs", () => {
    expect(Identifier.ascending("message") > "msg_0f1a2b3c4d5eZyXwVuTsRqPoNm").toBe(true)
  })

  test("timestamp decodes prefixed IDs", () => {
    expect(times.map((time) => Identifier.timestamp(Identifier.create("tool", "ascending", time)))).toEqual(times)
    expect(Identifier.timestamp("msg_000000001001AbCdEfGhIjKlMn")).toBe(1)
  })
})
