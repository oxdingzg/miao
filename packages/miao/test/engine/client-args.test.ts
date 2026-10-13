import { expect, test } from "bun:test"
import { engineArgs, type EngineOptions } from "../../src/engine/client"

const base: EngineOptions = { binary: "/bin/engine", db: "db", workspace: "/ws", model: "m" }

test("context limits ride the spawn args only when configured", () => {
  const plain = engineArgs(base)
  expect(plain).not.toContain("--context-limits")
  const configured = engineArgs({
    ...base,
    contextLimits: { window: 200_000, ratio: 0.85, headroom: 20_000, perPass: 50 },
  })
  const at = configured.indexOf("--context-limits")
  expect(at).toBeGreaterThan(-1)
  expect(JSON.parse(configured[at + 1]!)).toEqual({
    window: 200_000,
    ratio: 0.85,
    headroom: 20_000,
    perPass: 50,
  })
})
