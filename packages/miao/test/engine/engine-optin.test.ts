import { describe, expect, test } from "bun:test"
import { applyEngineOptIn, engineStorageRoot } from "../../src/engine/native-engine"

// Switch-plan step 3: the opt-in flag must work without any prior
// `engine.storage` configuration, must not clobber an explicit environment
// value, and `ts` must be able to opt a single command out of a configured
// `engine.storage`.
describe("applyEngineOptIn", () => {
  test("native defaults the storage under the data directory", () => {
    const env: Record<string, string | undefined> = {}
    applyEngineOptIn("native", "/data", env)
    expect(env.MIAO_ENGINE_STORAGE).toBe("/data/engines")
  })

  test("an explicit environment storage wins over native", () => {
    const env: Record<string, string | undefined> = { MIAO_ENGINE_STORAGE: "/elsewhere" }
    applyEngineOptIn("native", "/data", env)
    expect(env.MIAO_ENGINE_STORAGE).toBe("/elsewhere")
  })

  test("ts clears a configured storage for this command", () => {
    const env: Record<string, string | undefined> = { MIAO_ENGINE_STORAGE: "/configured" }
    applyEngineOptIn("ts", "/data", env)
    expect(env.MIAO_ENGINE_STORAGE).toBe("")
    expect(engineStorageRoot(env, { storage: "/configured" })).toBeUndefined()
  })

  test("no flag leaves the environment untouched", () => {
    const env: Record<string, string | undefined> = {}
    applyEngineOptIn(undefined, "/data", env)
    expect(env.MIAO_ENGINE_STORAGE).toBeUndefined()
  })
})
