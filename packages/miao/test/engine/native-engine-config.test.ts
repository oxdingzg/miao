import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { engineSettings, nativeEngineOptions } from "@/engine/native-engine"

test("reads the engine section from the global config; later files win whole", async () => {
  const dir = mkdtempSync("/tmp/engine-config-")
  writeFileSync(
    `${dir}/miao.json`,
    JSON.stringify({ engine: { model: "glm-5.3-flash", provider: "zhipuai-coding-plan" } }),
  )
  // JSONC: comments and trailing commas must survive, and a later file
  // replaces the whole section, matching the Config service document layering.
  writeFileSync(
    `${dir}/miao.jsonc`,
    `{ // operator override\n  "engine": { "model": "glm-5.3-air", "fallback_model": "glm-5.3-flash", }\n}`,
  )
  const settings = await engineSettings(dir)
  expect(settings?.model).toBe("glm-5.3-air")
  expect(settings?.fallbackModel).toBe("glm-5.3-flash")
  expect(settings?.provider).toBeUndefined()
})

test("a global config without an engine section leaves settings undefined", async () => {
  const dir = mkdtempSync("/tmp/engine-config-")
  writeFileSync(`${dir}/miao.json`, JSON.stringify({ model: "some-model" }))
  expect(await engineSettings(dir)).toBeUndefined()
})

test("the environment overrides the configured engine key by key", () => {
  const settings = {
    binary: "",
    model: "glm-5.3-air",
    provider: "zhipuai-coding-plan",
    promptCache: true,
    verifyCommand: "bun run check",
  }
  const options = nativeEngineOptions({ MIAO_ENGINE_BIN: "/bin/engine", MIAO_ENGINE_MODEL: "override" }, settings)
  expect(options?.model).toBe("override")
  expect(options?.provider).toBe("zhipuai-coding-plan")
  expect(options?.promptCache).toBe(true)
  expect(options?.verifyCommand).toBe("bun run check")
})
