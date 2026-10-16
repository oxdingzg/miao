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
    const clock = { time: 0 }
    let calls = 0
    const source = createTurnDiffSource(
      async () => {
        calls += 1
        throw new Error("boom")
      },
      { retryAfterMs: 10, now: () => clock.time },
    )

    source.load("s", "m1")
    await Bun.sleep(0)
    expect(calls).toBe(1)
    expect(source.get("s", "m1")).toBeUndefined()

    clock.time = 9
    source.load("s", "m1")
    await Bun.sleep(0)
    expect(calls).toBe(1)

    clock.time = 10
    source.load("s", "m1")
    await Bun.sleep(0)
    expect(calls).toBe(2)
  })
})
