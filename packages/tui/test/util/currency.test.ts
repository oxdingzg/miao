import { describe, expect, test } from "bun:test"
import { Currency } from "../../src/util/currency"

describe("util.currency", () => {
  test("converts a USD amount with the static rate", () => {
    expect(Currency.format(1, "CNY")).toBe(Currency.amount(7.3, "CNY"))
  })

  test("formats a native amount without conversion", () => {
    expect(Currency.amount(7.3, "CNY")).toContain("7.3")
  })

  test("falls back to USD for an unknown code", () => {
    expect(Currency.find("NOPE").code).toBe("USD")
  })

  test("resolves a model's native currency", () => {
    const providers = [{ id: "deepseek", models: { flash: { currency: "CNY" } } }]

    expect(Currency.native(providers, "deepseek", "flash")).toBe("CNY")
    expect(Currency.native(providers, "deepseek", "missing")).toBeUndefined()
    expect(Currency.native(providers, "other", "flash")).toBeUndefined()
    expect(Currency.native(providers, undefined, "flash")).toBeUndefined()
  })
})
