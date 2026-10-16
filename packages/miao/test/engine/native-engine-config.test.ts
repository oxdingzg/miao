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

test("global cache contracts reach the child and explicit environment overrides are validated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-cache-contract-"))
  const contract = {
    model: "wire-model",
    endpoint: "https://api.example/responses",
    authentication: "api",
    profile: "breakpoints",
    ttl: "30m",
  }
  try {
    writeFileSync(
      path.join(dir, "miao.json"),
      JSON.stringify({ engine: { model: "wire-model", responses_cache_contract: contract } }),
    )
    const settings = await engineSettings(dir)
    expect(settings?.responsesCacheContract).toMatchObject(contract)
    const options = nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" }, settings)
    if (!options) throw new Error("expected configured engine")
    const args = engineArgs({ ...options, db: "store.db", workspace: "workspace" })
    expect(JSON.parse(args[args.indexOf("--responses-cache-contract") + 1] ?? "null")).toEqual(contract)
    const disabled = { ...contract, mode: "disabled" }
    const overridden = nativeEngineOptions(
      { MIAO_ENGINE_BIN: "engine", MIAO_ENGINE_RESPONSES_CACHE_CONTRACT: JSON.stringify(disabled) },
      settings,
    )
    expect(overridden?.responsesCacheContract?.mode).toBe("disabled")
    expect(nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" })?.responsesCacheContract).toBeUndefined()
    for (const invalid of [{ prewarm: true }, { unknownCacheControl: true }])
      expect(() =>
        nativeEngineOptions({
          MIAO_ENGINE_BIN: "engine",
          MIAO_ENGINE_RESPONSES_CACHE_CONTRACT: JSON.stringify({ ...contract, ...invalid }),
        }),
      ).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const capability of ["mcp", "lsp"] as const) {
  test(`native ${capability} host config resolves globally and reaches the child arguments`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `native-${capability}-config-`))
    const field = capability === "mcp" ? "mcpConfigFile" : "lspConfigFile"
    try {
      writeFileSync(
        path.join(dir, "miao.json"),
        JSON.stringify({
          engine: { model: "fixture", [`${capability}_config`]: "host.json" },
        }),
      )
      const settings = await engineSettings(dir)
      expect(settings?.[field]).toBe(path.resolve(dir, "host.json"))
      const options = nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" }, settings)
      if (!options) throw new Error("configured binary must produce engine options")
      const args = engineArgs({ ...options, db: "store.db", workspace: "workspace" })
      expect(args[args.indexOf(`--${capability}-config`) + 1]).toBe(path.resolve(dir, "host.json"))
      const overridden = nativeEngineOptions(
        {
          MIAO_ENGINE_BIN: "engine",
          [`MIAO_ENGINE_${capability.toUpperCase()}_CONFIG`]: "operator.json",
        },
        settings,
      )
      expect(overridden?.[field]).toBe(path.resolve("operator.json"))
      expect(nativeEngineOptions({ MIAO_ENGINE_BIN: "engine" })?.[field]).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("global MCP documents merge without requiring an engine section", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-mcp-shared-"))
  try {
    writeFileSync(
      path.join(dir, "miao.json"),
      JSON.stringify({
        mcp: { servers: { first: { type: "local", command: ["node", "first.js"] } } },
      }),
    )
    writeFileSync(
      path.join(dir, "miao.jsonc"),
      JSON.stringify({
        mcp: { servers: { second: { type: "local", command: ["node", "second.js"] } } },
      }),
    )
    const settings = await engineSettings(dir)
    expect(Object.keys(settings?.mcpSettings?.servers ?? {})).toEqual(["first", "second"])
    const options = nativeEngineOptions({ MIAO_ENGINE_BIN: "engine", MIAO_ENGINE_MODEL: "fixture" }, settings)
    expect(options?.mcpSettings?.servers?.second).toMatchObject({ command: ["node", "second.js"] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
