import { Location } from "@miao/core/location"
import { PermissionHandoff } from "@miao/core/permission/handoff"
import type { Database } from "@miao/core/database/database"
import { NativePermissionContext } from "./native-permission-context"
import { prepareSharedPermissionOwner } from "./native-shared-permission-startup"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Effect, Option, Schema } from "effect"
import { EngineError, type EngineOptions, type EngineClient } from "./client"

/** Select paired Root ownership when requested or already migrated; otherwise
 * refresh the existing legacy saved-rule projection. */
export const prepare = Effect.fn("Engine.productPermission")(function* (
  location: Location.Ref,
  startup?: {
    binary: string
    source: string
    database: Database.Interface
    enabled: boolean
    savedRules?: string
  },
) {
  const options: Partial<EngineOptions> = {}
  const saved = Option.getOrUndefined(yield* Effect.serviceOption(PermissionSaved.Service))
  const opened = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!opened || opened.directory !== location.directory) {
    if (startup?.enabled)
      return yield* Effect.fail(
        new EngineError("engine_shared_permissions", "shared permission startup requires the actual Location binding"),
      )
    return { options, refresh: () => Effect.void }
  }
  const handoff = startup
    ? yield* PermissionHandoff.read(startup.database.db, opened.project.id).pipe(
        Effect.mapError((error) => new EngineError("engine_shared_permissions", error.message)),
      )
    : undefined
  if (startup && (startup.enabled || handoff)) {
    if (
      location.workspaceID !== undefined ||
      startup.database.storage === ":memory:" ||
      startup.savedRules !== undefined
    )
      return yield* Effect.fail(
        new EngineError(
          "engine_shared_permissions",
          "shared permissions require persistent implicit-local storage without legacy snapshots",
        ),
      )
    const paired = yield* Effect.tryPromise({
      try: () =>
        prepareSharedPermissionOwner({
          binary: startup.binary,
          source: startup.source,
          root: `${startup.database.storage}.permissions.db`,
          directory: opened.directory,
          projectID: opened.project.id,
          db: startup.database.db,
        }),
      catch: (error) =>
        new EngineError("engine_shared_permissions", error instanceof Error ? error.message : String(error)),
    })
    return {
      options: paired.options,
      refresh: (client: Pick<EngineClient, "request">) =>
        Effect.tryPromise({
          try: async () => {
            const observed = Schema.decodeUnknownSync(NativePermissionContext.Observation)(
              await client.request("shared_permission_snapshot"),
            )
            const snapshot = observed.snapshot
            if (
              snapshot.project.authority !== paired.snapshot.project.authority ||
              snapshot.project.project !== opened.project.id ||
              snapshot.directory !== paired.snapshot.directory ||
              snapshot.migration?.fingerprint !== paired.snapshot.migration?.fingerprint
            )
              throw new Error("managed shared permission owner binding changed")
          },
          catch: (error) =>
            new EngineError("engine_shared_permissions", error instanceof Error ? error.message : String(error)),
        }),
    }
  }
  if (!saved) return { options, refresh: () => Effect.void }
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
