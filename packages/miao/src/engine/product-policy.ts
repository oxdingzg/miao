import { Effect } from "effect"
import type { EngineOptions } from "./client"

/**
 * Product-owned capability policy for a native Session.
 *
 * The product's ordered agent rules decide allow/ask/deny for each call; the
 * policy only opens the capability families those rules can address. Since S5
 * step 2 the engine derives that policy itself from the config directory and
 * the environment, so the host passes the directory instead of materializing a
 * temporary policy file.
 *
 * An explicit `MIAO_ENGINE_POLICY` remains the operator's authority boundary
 * and always wins; the directory is passed only when that is absent.
 */
export const prepare = Effect.fn("Engine.productPolicy")(function* (
  configuration: Pick<EngineOptions, "policyFile">,
  globalConfig: string,
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.policyFile) return options
  options.configDir = globalConfig
  return options
})

export * as ProductPolicy from "./product-policy"
