import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProductPolicy } from "../../src/engine/product-policy"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live("passes the global config directory so the engine derives the policy", () =>
  Effect.gen(function* () {
    expect(yield* ProductPolicy.prepare({}, "/global/config")).toEqual({ configDir: "/global/config" })
  }),
)

it.live("an explicit operator policy is never replaced", () =>
  Effect.gen(function* () {
    expect(yield* ProductPolicy.prepare({ policyFile: "/operator/policy.json" }, "/global/config")).toEqual({})
  }),
)
