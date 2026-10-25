import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProductPolicy } from "../../src/engine/product-policy"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live("generates the product capability policy when no explicit policy is configured", () =>
  Effect.gen(function* () {
    const file = yield* Effect.gen(function* () {
      const options = yield* ProductPolicy.prepare({}, true)
      if (!options.policyFile) throw new Error("missing generated native policy")
      expect(yield* Effect.promise(() => Bun.file(options.policyFile!).json())).toEqual({
        mode: "workspace",
        allow_process: true,
        allow_background: true,
        allow_subagents: true,
        allow_mcp: true,
        allow_web: true,
        allow_wakeup: true,
        allow_cron: true,
        process_network: true,
        sandbox: true,
        max_provider_turns: null,
      })
      if (process.platform !== "win32")
        expect((yield* Effect.promise(() => Bun.file(options.policyFile!).stat())).mode & 0o777).toBe(0o600)
      return options.policyFile
    }).pipe(Effect.scoped)
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

it.live("an explicit operator policy is never replaced", () =>
  Effect.gen(function* () {
    expect(yield* ProductPolicy.prepare({ policyFile: "/operator/policy.json" }, true)).toEqual({})
  }),
)

it.live("records an operator sandbox opt-out in the generated policy", () =>
  Effect.gen(function* () {
    const policy = yield* Effect.gen(function* () {
      const options = yield* ProductPolicy.prepare({}, false)
      if (!options.policyFile) throw new Error("missing generated native policy")
      return yield* Effect.promise(() => Bun.file(options.policyFile!).json())
    }).pipe(Effect.scoped)
    expect(policy.sandbox).toBe(false)
  }),
)
