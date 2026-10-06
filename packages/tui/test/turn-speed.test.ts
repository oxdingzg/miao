import { describe, expect, test } from "bun:test"
import { turnSpeed } from "../src/util/turn-speed"
import type { TranscriptAssistantMessage } from "@miao/schema/view-models"
import { testAssistantMessage } from "./lib/v2-message"

function turn(output: number, created: number, completed?: number): TranscriptAssistantMessage {
  return testAssistantMessage({
    model: { id: "acme-1", providerID: "acme" },
    tokens: { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } },
    created,
    completed,
  })
}

describe("turnSpeed", () => {
  test("reports output tokens over the whole turn", () => {
    const speed = turnSpeed(turn(200, 0, 4000))
    expect(speed?.output).toBe(200)
    expect(speed?.duration).toBe(4000)
    expect(speed?.tps).toBe(50)
  })

  test("counts tool time in the denominator rather than hiding it", () => {
    // The same 200 tokens taking twice as long report half the rate, because the
    // span covers the tool calls the turn made.
    expect(turnSpeed(turn(200, 0, 8000))?.tps).toBe(25)
  })

  test("reports nothing for a turn still in flight", () => {
    expect(turnSpeed(turn(200, 0))).toBeUndefined()
  })

  test("reports nothing for a turn that produced no output", () => {
    expect(turnSpeed(turn(0, 0, 4000))).toBeUndefined()
  })

  test("reports nothing rather than dividing by a zero span", () => {
    expect(turnSpeed(turn(200, 1000, 1000))).toBeUndefined()
  })
})
