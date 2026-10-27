import { Location } from "@miao/core/location"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Effect, Option } from "effect"
import type { EngineOptions } from "./client"

/**
 * Project the project's saved "always allow" rules into the owner's engine
 * store (S6 step 2): the rules a user already granted on this project answer a
 * native Session's asks the same way they answer a TypeScript Session's.
 */
export const prepare = Effect.fn("Engine.productPermission")(function* (location: Location.Ref) {
  const options: Partial<EngineOptions> = {}
  const saved = Option.getOrUndefined(yield* Effect.serviceOption(PermissionSaved.Service))
  const opened = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!saved || !opened || opened.directory !== location.directory) return options
  const rules = yield* saved.list({ projectID: opened.project.id })
  if (rules.length === 0) return options
  options.savedRules = JSON.stringify(
    rules.map((item) => ({ action: item.action, resource: item.resource, effect: "allow" })),
  )
  return options
})

export * as ProductPermission from "./product-permission"
