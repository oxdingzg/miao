import { expect, test } from "bun:test"
import { maxContext } from "@miao/core/config/compaction"
import { Token } from "@miao/core/util/token"
import { Wildcard } from "@miao/core/util/wildcard"

test("parseQuantity accepts plain counts, K/M shorthand, and percentages", () => {
  expect(Token.parseQuantity(300_000)).toBe(300_000)
  expect(Token.parseQuantity(1.5)).toBe(1)
  expect(Token.parseQuantity("300K")).toBe(300_000)
  expect(Token.parseQuantity("300k")).toBe(300_000)
  expect(Token.parseQuantity("1.5M")).toBe(1_500_000)
  expect(Token.parseQuantity("0.5K")).toBe(500)
  expect(Token.parseQuantity(" 200000 ")).toBe(200_000)
  expect(Token.parseQuantity("50%", 200_000)).toBe(100_000)
  expect(Token.parseQuantity("37.5%", 200_000)).toBe(75_000)
})

test("parseQuantity rejects invalid quantities", () => {
  expect(Token.parseQuantity(-1)).toBeUndefined()
  expect(Token.parseQuantity(Number.NaN)).toBeUndefined()
  expect(Token.parseQuantity("300KB")).toBeUndefined()
  expect(Token.parseQuantity("K")).toBeUndefined()
  expect(Token.parseQuantity("abc")).toBeUndefined()
  expect(Token.parseQuantity("50%")).toBeUndefined()
  expect(Token.parseQuantity("150%", 200_000)).toBeUndefined()
  expect(Token.parseQuantity("0%", 200_000)).toBeUndefined()
})

test("Wildcard.all prefers the longest matching key", () => {
  const values = { "*": 1, "openai/*": 2, "openai/gpt-*": 3, "openai/gpt-5?": 4 }
  expect(Wildcard.all("openai/gpt-56", values)).toBe(4)
  expect(Wildcard.all("openai/gpt-567", values)).toBe(3)
  expect(Wildcard.all("anthropic/claude", values)).toBe(1)
  expect(Wildcard.all("ollama/llama", values)).toBe(1)
  expect(Wildcard.all("openai/embed", { "openai/gpt-*": 3 })).toBeUndefined()
})

const resolve = (configured: Parameters<typeof maxContext>[0]["configured"], context = 200_000) =>
  maxContext({ configured, provider: "openai", model: "gpt-5", context })

test("a scalar max_context applies to every model", () => {
  expect(resolve(100_000)).toBe(100_000)
  expect(resolve("300K", 400_000)).toBe(300_000)
  expect(resolve("50%")).toBe(100_000)
})

test("a max_context map matches by provider/model with globs", () => {
  expect(resolve({ "openai/gpt-5": "150K" })).toBe(150_000)
  expect(resolve({ "openai/*": "120K", "anthropic/*": 90_000 })).toBe(120_000)
  expect(resolve({ "openai/gpt-*": 120_000, "*": 90_000 })).toBe(120_000)
  expect(resolve({ "anthropic/*": 90_000 })).toBeUndefined()
})

test("max_context never raises the model window", () => {
  expect(resolve(300_000)).toBeUndefined()
  expect(resolve("100%", 200_000)).toBeUndefined()
})

test("max_context 0 restores the model default", () => {
  expect(resolve(0)).toBeUndefined()
  expect(resolve({ "openai/gpt-5": 0, "*": 90_000 })).toBeUndefined()
})

test("unparseable max_context is ignored", () => {
  expect(resolve("soon")).toBeUndefined()
  expect(resolve(-5 as never)).toBeUndefined()
  expect(resolve("")).toBeUndefined()
})

test("max_context without a window resolves to nothing", () => {
  expect(maxContext({ configured: 100_000, provider: "openai", model: "gpt-5", context: 0 })).toBeUndefined()
})
