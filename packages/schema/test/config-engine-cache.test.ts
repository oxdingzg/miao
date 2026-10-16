import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config, ResponsesCacheContract } from "../src/config"

const value = {
  model: "wire-model",
  endpoint: "https://api.example/responses",
  authentication: "api",
  profile: "breakpoints",
} as const

test("engine cache contracts have one canonical identity and omit optional wire fields", () => {
  expect(Config.ResponsesCacheContract).toBe(ResponsesCacheContract)
  const contract = Schema.decodeUnknownSync(ResponsesCacheContract)(value)
  const encoded = Schema.encodeSync(ResponsesCacheContract)(contract)
  expect(encoded).toEqual(value)
  for (const field of ["mode", "ttl", "retention", "system", "prewarm"]) expect(encoded).not.toHaveProperty(field)
})

test("normal model contracts reject generation-free prewarming and unsupported enum controls", () => {
  for (const patch of [
    { prewarm: true },
    { ttl: "1h" },
    { authentication: "unknown" },
    { profile: "unknown" },
    { mode: "unknown" },
  ])
    expect(() => Schema.decodeUnknownSync(ResponsesCacheContract)({ ...value, ...patch })).toThrow()
  expect(Schema.decodeUnknownSync(ResponsesCacheContract)({ ...value, prewarm: false }).prewarm).toBe(false)
})
