import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { engineSettings, nativeEngineOptions } from "@/engine/native-engine"
import { engineArgs } from "@/engine/client"

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

test("native LSP host config resolves globally and reaches the child arguments", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-lsp-config-"))
  try {
    writeFileSync(path.join(dir, "miao.json"), JSON.stringify({
      engine: { model: "fixture", lsp_config: "host-lsp.json" },
    }))
    const settings = await engineSettings(dir)
    expect(settings?.lspConfigFile).toBe(path.resolve(dir, "host-lsp.json"))
    const options = nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" }, settings)
    if (!options) throw new Error("configured binary must produce engine options")
    const args = engineArgs({ ...options, db: "store.db", workspace: "workspace" })
    expect(args[args.indexOf("--lsp-config") + 1]).toBe(path.resolve(dir, "host-lsp.json"))
    const overridden = nativeEngineOptions({
      MIAO_ENGINE_BIN: "engine",
      MIAO_ENGINE_LSP_CONFIG: "operator-lsp.json",
    }, settings)
    expect(overridden?.lspConfigFile).toBe(path.resolve("operator-lsp.json"))
    expect(nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" })?.lspConfigFile).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
