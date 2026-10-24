import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { EngineError, type EngineOptions } from "./client"

/**
 * Product-owned capability policy for a native Session.
 *
 * The product's ordered agent rules decide allow/ask/deny for each call; this
 * policy only opens the capability families those rules can address. Without
 * it the engine keeps its read-only default, so an automatically discovered
 * engine would surface no coding tools at all.
 *
 * An explicit `MIAO_ENGINE_POLICY` remains the operator's authority boundary
 * and always wins; this file is generated only when that is absent.
 */
export const prepare = Effect.fn("Engine.productPolicy")(function* (configuration: Pick<EngineOptions, "policyFile">) {
  const options: Partial<EngineOptions> = {}
  if (configuration.policyFile) return options
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-policy-")),
      catch: () => new EngineError("engine_policy_io", "could not create native policy directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "policy.json")
  const content = JSON.stringify({
    mode: "workspace",
    allow_process: true,
    allow_background: true,
    allow_subagents: true,
    allow_mcp: true,
    allow_web: true,
    allow_wakeup: true,
    allow_cron: true,
    process_network: true,
    // Product tasks routinely exceed the standalone engine's 25-turn default.
    // Explicit operator policies and narrower agent.steps remain authoritative.
    max_provider_turns: 1000,
  })
  yield* Effect.tryPromise({
    try: () => writeFile(file, content, { mode: 0o600 }),
    catch: () => new EngineError("engine_policy_io", "could not write native policy"),
  })
  options.policyFile = file
  return options
})

export * as ProductPolicy from "./product-policy"
