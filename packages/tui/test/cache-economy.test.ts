import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@miao/sdk/v2"
import type { ProviderLike } from "../src/util/currency"
import { cacheEconomy } from "../src/util/cache-economy"

// Anthropic-style per-million rates: reads bill at a tenth of input, writes at
// 1.25x, and a request past 200k tokens pays double for everything.
const PRICED = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
const TIERED = {
  ...PRICED,
  tiers: [{ input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 }, tier: { type: "context", size: 200_000 } }],
}

function provider(cost?: Record<string, unknown>): ProviderLike {
  return { id: "acme", models: { "acme-1": cost ? { cost } : {} } }
}

function turn(cache: { read: number; write: number }, modelID = "acme-1", input = 0): AssistantMessage {
  return {
    role: "assistant",
    providerID: "acme",
    modelID,
    tokens: { input, output: 0, reasoning: 0, cache },
  } as unknown as AssistantMessage
}

describe("cacheEconomy", () => {
  test("earns the discount between the read and input rates", () => {
    const economy = cacheEconomy([turn({ read: 1000, write: 0 })], [provider(PRICED)])
    expect(economy.read).toBe(1000)
    expect(economy.write).toBe(0)
    expect(economy.saved).toBeCloseTo((1000 * 2.7) / 1_000_000, 12)
  })

  test("charges the write premium against the savings", () => {
    const economy = cacheEconomy([turn({ read: 1000, write: 2000 })], [provider(PRICED)])
    expect(economy.saved).toBeCloseTo((1000 * 2.7 - 2000 * 0.75) / 1_000_000, 12)
  })

  test("treats an unquoted cache price as the input rate", () => {
    const economy = cacheEconomy([turn({ read: 1000, write: 2000 })], [provider({ input: 3, output: 15 })])
    expect(economy.read).toBe(1000)
    expect(economy.write).toBe(2000)
    expect(economy.saved).toBe(0)
  })

  test("prices a long request at the tier its inclusive input reaches", () => {
    const over = cacheEconomy([turn({ read: 1000, write: 0 }, "acme-1", 250_000)], [provider(TIERED)])
    expect(over.saved).toBeCloseTo((1000 * 5.4) / 1_000_000, 12)
    const under = cacheEconomy([turn({ read: 1000, write: 0 }, "acme-1", 100_000)], [provider(TIERED)])
    expect(under.saved).toBeCloseTo((1000 * 2.7) / 1_000_000, 12)
  })

  test("sums across turns and skips models it cannot price", () => {
    const economy = cacheEconomy(
      [turn({ read: 1000, write: 0 }), turn({ read: 500, write: 100 }, "retired"), turn({ read: 500, write: 0 })],
      [provider(PRICED)],
    )
    expect(economy.read).toBe(1500)
    expect(economy.write).toBe(0)
    expect(economy.saved).toBeCloseTo((1500 * 2.7) / 1_000_000, 12)
  })

  test("reports nothing when no provider matches", () => {
    const economy = cacheEconomy([turn({ read: 1000, write: 1000 })], [])
    expect(economy).toEqual({ read: 0, write: 0, saved: 0 })
  })
})
