import { nativeModelLabel } from "../../src/util/native-model"
import { describe, expect, test } from "bun:test"
import { parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })
})

describe("native model labels", () => {
  test("uses the catalog name for an exact host route and preserves nested ids", () => {
    const provider = {
      id: "vendor",
      name: "Vendor",
      source: "custom" as const,
      env: [],
      options: {},
      models: {},
    }
    expect(
      nativeModelLabel(
        { model: { providerID: "native-engine", id: "vendor/org/model" }, protocol: "openai-chat", wireModel: "wire" },
        [provider],
      ),
    ).toEqual({ provider: "Vendor", providerID: "vendor", model: "wire" })
    for (const ref of [
      { providerID: "native-engine-default", id: "default" },
      { providerID: "native-engine", id: "account/hash" },
    ])
      expect(
        nativeModelLabel(
          {
            model: ref,
            productModel: { providerID: "vendor", id: "org/model" },
            protocol: "openai-chat",
            wireModel: "wire",
          },
          [provider],
        ),
      ).toEqual({ provider: "Vendor", providerID: "vendor", model: "wire" })
  })
  test("shows the actual host wire model for defaults and opaque account routes", () => {
    expect(
      nativeModelLabel(
        {
          model: { providerID: "native-engine-default", id: "default" },
          protocol: "gemini",
          wireModel: "gemini-flash",
        },
        [],
      ),
    ).toEqual({ provider: "gemini", providerID: undefined, model: "gemini-flash" })
    expect(
      nativeModelLabel(
        { model: { providerID: "native-engine", id: "account/hash" }, protocol: "openai-chat", wireModel: "flash" },
        [],
      ).model,
    ).toBe("flash")
  })
})
