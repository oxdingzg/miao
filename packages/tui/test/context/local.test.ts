import { expect, test } from "bun:test"
import { parseModel, readModelRecord, recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("hydrates per-agent persisted models and drops malformed entries", () => {
  expect(
    readModelRecord({
      build: { providerID: "provider", modelID: "family/model" },
      plan: { providerID: "provider" },
      broken: "nope",
      empty: null,
    }),
  ).toEqual({ build: { providerID: "provider", modelID: "family/model" } })
})
