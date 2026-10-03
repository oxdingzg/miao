import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@miao/sdk/v2"
import { cacheTrend } from "../src/util/cache-trend"

/** A turn whose input is `read` cached tokens plus `fresh` uncached ones. */
function turn(read: number, fresh = 100): AssistantMessage {
  return {
    role: "assistant",
    providerID: "acme",
    modelID: "acme-1",
    tokens: { input: fresh, output: 0, reasoning: 0, cache: { read, write: 0 } },
    time: { created: 0 },
  } as unknown as AssistantMessage
}

/** Turns whose hit rate climbs from `from` to `to`, in equal steps. */
function ramp(from: number, to: number, count: number) {
  return Array.from({ length: count }, (_, index) => turn(from + ((to - from) * index) / (count - 1)))
}

describe("cacheTrend", () => {
  test("reads a rising hit rate as up", () => {
    expect(cacheTrend(ramp(0, 900, 4))).toBe("up")
  })

  test("reads a falling hit rate as down", () => {
    expect(cacheTrend(ramp(900, 0, 4))).toBe("down")
  })

  test("reads a steady hit rate as flat", () => {
    expect(cacheTrend(ramp(500, 500, 4))).toBe("flat")
    expect(cacheTrend(ramp(500, 510, 4))).toBe("flat")
  })

  test("looks only at the most recent turns", () => {
    // A cold start followed by a steady cache reads as flat, not as a rise, once
    // the cold turns have fallen out of the window.
    const messages = [...ramp(0, 0, 10), ...ramp(900, 900, 10)]
    expect(cacheTrend(messages)).toBe("flat")
  })

  test("reports nothing until enough turns have cached to compare", () => {
    expect(cacheTrend([])).toBeUndefined()
    expect(cacheTrend(ramp(0, 900, 3))).toBeUndefined()
  })

  test("ignores turns that never cached, which carry no hit rate", () => {
    expect(cacheTrend([...ramp(0, 900, 4), turn(0, 0)])).toBe("up")
  })
})
