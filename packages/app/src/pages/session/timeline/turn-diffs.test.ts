import { describe, expect, test } from "bun:test"
import { createTurnDiffSource } from "./turn-diffs"

describe("createTurnDiffSource", () => {
  test("loads each turn once and caches the result", async () => {
    let calls = 0
    const source = createTurnDiffSource(async () => {
      calls += 1
      return [{ file: "src/a.ts", additions: 1, deletions: 0, patch: "" }]
    })

    source.load("s", "m1")
    source.load("s", "m1")
    await Bun.sleep(0)
    expect(calls).toBe(1)
    expect(source.get("s", "m1")?.[0]?.file).toBe("src/a.ts")
  })

  test("retries a failed turn only after the cool-off", async () => {
    let calls = 0
    const source = createTurnDiffSource(
      async () => {
        calls += 1
        throw new Error("boom")
      },
      { retryAfterMs: 10 },
    )
    const realNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      source.load("s", "m1")
      await Bun.sleep(0)
      expect(calls).toBe(1)
      expect(source.get("s", "m1")).toBeUndefined()

      now += 5
      source.load("s", "m1")
      await Bun.sleep(0)
      expect(calls).toBe(1)

      now += 10
      source.load("s", "m1")
      await Bun.sleep(0)
      expect(calls).toBe(2)
    } finally {
      Date.now = realNow
    }
  })
})
