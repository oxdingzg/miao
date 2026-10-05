import { describe, expect, it } from "bun:test"
import { ModelsOverlay } from "@miao/core/models-overlay"
import type { ModelsDev } from "@miao/core/models-dev"

describe("ModelsOverlay", () => {
  it("adds miao-maintained providers that models.dev does not list", () => {
    const merged = ModelsOverlay.merge({})
    expect(merged.commandcode?.name).toBe("Command Code")
    expect(merged.commandcode?.env).toEqual(["CMD_API_KEY", "COMMAND_CODE_API_KEY"])
  })

  it("lets the overlay win on provider identity while keeping catalog models", () => {
    const catalog: Record<string, ModelsDev.Provider> = {
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
    const catalog: Record<string, ModelsDev.Provider> = {}
    ModelsOverlay.merge(catalog)
    expect(catalog.commandcode).toBeUndefined()
  })
})
