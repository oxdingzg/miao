import { describe, expect, it } from "bun:test"
import { ModelsOverlay } from "@miao/core/models-overlay"
import type { ModelsCatalog } from "@miao/core/models-catalog"

describe("ModelsOverlay", () => {
  it("adds miao-maintained providers that models.dev does not list", () => {
    const merged = ModelsOverlay.merge({})
    expect(merged.commandcode?.name).toBe("Command Code")
    expect(merged.commandcode?.env).toEqual(["CMD_API_KEY", "COMMAND_CODE_API_KEY"])
  })

  it("lets the overlay win on provider identity while keeping catalog models", () => {
    const catalog: Record<string, ModelsCatalog.Provider> = {
      commandcode: {
        id: "commandcode",
        name: "Wrong Name",
        env: [],
        api: "https://old.example",
        models: {
          "some-model": {
            id: "some-model",
            name: "Some Model",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 1000, output: 100 },
          },
        },
      },
    }
    const merged = ModelsOverlay.merge(catalog)
    expect(merged.commandcode?.name).toBe("Command Code")
    expect(merged.commandcode?.api).toBe("https://api.commandcode.ai")
    expect(Object.keys(merged.commandcode?.models ?? {})).toEqual(["some-model"])
  })

  it("does not mutate the input catalog", () => {
    const catalog: Record<string, ModelsCatalog.Provider> = {}
    ModelsOverlay.merge(catalog)
    expect(catalog.commandcode).toBeUndefined()
  })

  it("patches plan-inclusive coding-plan models with standard-API reference costs", () => {
    const merged = ModelsOverlay.merge({})
    expect(merged["zhipuai-coding-plan"]?.models["glm-5.3-flash"]?.cost).toEqual({
      input: 0.11952,
      output: 0.41831,
      cache_read: 0.03436,
      cache_write: 0,
    })
    expect(merged["zhipuai-coding-plan"]?.models["glm-5.3"]?.cost).toEqual({
      input: 1.19516,
      output: 4.18306,
      cache_read: 0.29879,
      cache_write: 0,
    })
  })

  it("merges overlay model patches field-wise over catalog entries", () => {
    const catalog: Record<string, ModelsCatalog.Provider> = {
      "zhipuai-coding-plan": {
        id: "zhipuai-coding-plan",
        name: "Zhipu AI Coding Plan",
        env: ["ZHIPU_API_KEY"],
        api: "https://open.bigmodel.cn/api/coding/paas/v4",
        models: {
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            release_date: "2026-08-26",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    }
    const merged = ModelsOverlay.merge(catalog)
    const model = merged["zhipuai-coding-plan"]?.models["glm-5.3-flash"]
    expect(model?.name).toBe("GLM-5.3-Flash")
    expect(model?.limit).toEqual({ context: 1_000_000, output: 131_072 })
    expect(model?.cost?.input).toBe(0.11952)
  })
})
