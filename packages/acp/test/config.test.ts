import { describe, expect, test } from "bun:test"
import { configOptions, defaultModel, initialVariant, parseModel, type Catalog } from "../src/config"

const catalog: Catalog = {
  directory: "/work",
  models: [
    {
      providerID: "test",
      providerName: "Test",
      id: "test-model",
      name: "Test Model",
      variants: ["low", "high"],
      context: 100,
    },
    { providerID: "test", providerName: "Test", id: "second-model", name: "Second", variants: [], context: 200 },
    {
      providerID: "other",
      providerName: "Other",
      id: "x/y",
      name: "Slashed",
      variants: ["default", "max"],
      context: 300,
    },
  ],
  modes: [
    { id: "build", name: "build" },
    { id: "plan", name: "plan", description: "read only" },
  ],
  defaultMode: "build",
  commands: [],
  defaultModel: { providerID: "test", id: "test-model" },
}

describe("configOptions", () => {
  test("lists model, effort and mode with the current selection", () => {
    const options = configOptions(catalog, {
      model: { providerID: "test", id: "test-model" },
      variant: "low",
      mode: "plan",
    })
    expect(options.map((option) => [option.id, option.category, option.currentValue])).toEqual([
      ["model", "model", "test/test-model"],
      ["effort", "thought_level", "low"],
      ["mode", "mode", "plan"],
    ])
    const effort = options.find((option) => option.id === "effort")
    expect(
      effort?.type === "select" ? effort.options.map((option) => ("value" in option ? option.value : "")) : [],
    ).toEqual(["low", "high", "default"])
  })

  test("omits effort for a model without variants and shows no override as default", () => {
    expect(
      configOptions(catalog, { model: { providerID: "test", id: "second-model" } }).map((option) => option.id),
    ).toEqual(["model"])
    const effort = configOptions(catalog, { model: { providerID: "test", id: "test-model" }, variant: "default" }).find(
      (option) => option.id === "effort",
    )
    expect(effort?.currentValue).toBe("default")
  })
})

describe("parseModel", () => {
  test("accepts provider/model, model IDs with slashes, and a trailing variant", () => {
    expect(parseModel("test/second-model", catalog)).toEqual({ model: { providerID: "test", id: "second-model" } })
    expect(parseModel("other/x/y", catalog)).toEqual({ model: { providerID: "other", id: "x/y" } })
    expect(parseModel("test/test-model/high", catalog)).toEqual({
      model: { providerID: "test", id: "test-model" },
      variant: "high",
    })
    expect(parseModel("test/test-model/huge", catalog)).toBeUndefined()
    expect(parseModel("missing/model", catalog)).toBeUndefined()
  })
})

describe("defaults", () => {
  test("prefer the Location default model and the default variant", () => {
    expect(defaultModel(catalog)).toEqual({ providerID: "test", id: "test-model" })
    expect(defaultModel({ ...catalog, defaultModel: undefined })).toEqual({ providerID: "test", id: "test-model" })
    expect(initialVariant(catalog, { providerID: "test", id: "test-model" })).toBe("low")
    expect(initialVariant(catalog, { providerID: "other", id: "x/y" })).toBe("default")
    expect(initialVariant(catalog, { providerID: "test", id: "second-model" })).toBeUndefined()
  })
})
