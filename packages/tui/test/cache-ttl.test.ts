import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { cacheTtl } from "../src/util/cache-ttl"

const MINUTE = 60_000

function turn(
  providerID: string,
  options: { read?: number; write?: number; startedAt?: number; completedAt?: number; summary?: boolean } = {},
): AssistantMessage {
  const startedAt = options.startedAt ?? 0
  const completedAt = options.completedAt ?? startedAt
  return {
    role: "assistant",
    providerID,
    modelID: "some-model",
    summary: options.summary,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: options.read ?? 0, write: options.write ?? 0 } },
    time: options.completedAt === undefined ? { created: startedAt } : { created: startedAt, completed: completedAt },
  } as unknown as AssistantMessage
}

describe("cacheTtl", () => {
  test("reads each provider's documented lifetime", () => {
    const ttl = (providerID: string) => cacheTtl([turn(providerID, { read: 1 })], 0)?.ttl
    expect(ttl("deepseek")).toBe(2 * 60 * MINUTE)
    expect(ttl("google")).toBe(60 * MINUTE)
    expect(ttl("anthropic")).toBe(5 * MINUTE)
    expect(ttl("openai")).toBe(5 * MINUTE)
  })

  test("falls back to the shortest lifetime for an unknown provider", () => {
    expect(cacheTtl([turn("some-gateway", { read: 1 })], 0)?.ttl).toBe(5 * MINUTE)
  })

  test("counts from the last turn that touched the cache", () => {
    const ttl = cacheTtl(
      [turn("anthropic", { read: 10, startedAt: 0 }), turn("anthropic", { read: 10, startedAt: 30 * MINUTE })],
      31 * MINUTE,
    )
    expect(ttl?.startedAt).toBe(30 * MINUTE)
    expect(ttl?.elapsed).toBe(MINUTE)
  })

  test("ignores a turn that left the cache alone", () => {
    const ttl = cacheTtl([turn("anthropic", { read: 10, startedAt: 0 }), turn("anthropic", { startedAt: 4 * MINUTE })], 4 * MINUTE)
    expect(ttl?.startedAt).toBe(0)
  })

  test("ignores a summary, which reports on earlier turns without a request of its own", () => {
    const ttl = cacheTtl(
      [turn("anthropic", { read: 10, startedAt: 0 }), turn("anthropic", { read: 10, startedAt: 9 * MINUTE, summary: true })],
      9 * MINUTE,
    )
    expect(ttl?.startedAt).toBe(0)
  })

  test("prefers the completion time so the clock starts when the request landed", () => {
    const ttl = cacheTtl([turn("anthropic", { read: 1, startedAt: 0, completedAt: 2 * MINUTE })], 3 * MINUTE)
    expect(ttl?.startedAt).toBe(2 * MINUTE)
    expect(ttl?.elapsed).toBe(MINUTE)
  })

  test("falls back to the start time for a turn still in flight", () => {
    const ttl = cacheTtl([turn("anthropic", { read: 1, startedAt: 2 * MINUTE })], 3 * MINUTE)
    expect(ttl?.startedAt).toBe(2 * MINUTE)
  })

  test("grades freshness against the lifetime, and against twice it", () => {
    const state = (elapsed: number) => cacheTtl([turn("anthropic", { read: 1, startedAt: 0 })], elapsed)?.state
    expect(state(4 * MINUTE)).toBe("fresh")
    expect(state(5 * MINUTE)).toBe("aging")
    expect(state(9 * MINUTE)).toBe("aging")
    expect(state(10 * MINUTE)).toBe("stale")
  })

  test("reports nothing for a session that never cached", () => {
    expect(cacheTtl([], 0)).toBeUndefined()
    expect(cacheTtl([turn("anthropic", { startedAt: 0 })], 0)).toBeUndefined()
  })
})
