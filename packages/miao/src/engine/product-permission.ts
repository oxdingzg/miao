import { Location } from "@miao/core/location"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Effect, Option } from "effect"
import { EngineError, type EngineOptions, type EngineClient } from "./client"

/**
 * Project the project's saved "always allow" rules into the owner's engine
 * store (S6 step 2): the rules a user already granted on this project answer a
 * native Session's asks the same way they answer a TypeScript Session's.
 */
export const prepare = Effect.fn("Engine.productPermission")(function* (location: Location.Ref) {
  const options: Partial<EngineOptions> = {}
  const saved = Option.getOrUndefined(yield* Effect.serviceOption(PermissionSaved.Service))
  const opened = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!saved || !opened || opened.directory !== location.directory) return { options, refresh: () => Effect.void }
  const snapshot = saved
    .list({ projectID: opened.project.id })
    .pipe(
      Effect.map((rules) => rules.map((item) => ({ action: item.action, resource: item.resource, effect: "allow" }))),
    )
  options.savedRules = JSON.stringify(yield* snapshot)
  return {
    options,
    refresh: (client: Pick<EngineClient, "request">) =>
      snapshot.pipe(
        Effect.flatMap((rules) =>
          Effect.tryPromise({
            try: () => client.request("permission_saved_snapshot", { workspace: location.directory, rules }),
            catch: (error) =>
              new EngineError("engine_saved_rules", error instanceof Error ? error.message : String(error)),
          }),
        ),
        Effect.asVoid,
      ),
  }
})

export * as ProductPermission from "./product-permission"
