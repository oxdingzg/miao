import { Effect, Schema } from "effect"
import type { Database } from "@miao/core/database/database"
import { PermissionHandoff } from "@miao/core/permission/handoff"
import type { ProjectV2 } from "@miao/core/project"
import type { EngineClient } from "./client"
import type { Capabilities } from "./discovery"

const Counter = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Receipt = Schema.Struct({ project: Schema.String, fingerprint: Schema.String, imported: Counter })
const Snapshot = Schema.Struct({
  authority: Schema.String,
  project: Schema.String,
  revision: Counter,
  migration: Schema.NullOr(Receipt),
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      origin: Schema.Literals(["native", "legacy"]),
      rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
    }),
  ).check(Schema.isMaxLength(512)),
})

/** Explicit trusted-host handoff. Never starts execution or falls back to legacy. */
export async function handoffNativeProjectPermissions(input: {
  db: Database.Interface["db"]
  projectID: ProjectV2.ID
  client: Pick<EngineClient, "request">
  capabilities: Pick<Capabilities, "permissionProjectStore" | "permissionProjectHandoff">
}) {
  if (input.capabilities.permissionProjectStore !== 1 || input.capabilities.permissionProjectHandoff !== 1)
    throw new Error("native project permission handoff capability required before freezing legacy rules")
  const read = async () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)(await input.client.request("snapshot"))
    if (snapshot.project !== input.projectID) throw new Error("native project permission binding mismatch")
    return snapshot
  }
  const before = await read()
  const prepare = (snapshot: typeof before) =>
    PermissionHandoff.prepare(input.db, {
      projectID: input.projectID,
      authority: before.authority,
      existing: snapshot.migration,
    })
  const prepared = await Effect.runPromise(
    prepare(before).pipe(
      // A peer may commit after our preflight snapshot but before Core preparation.
      // Refresh that observation once; never change the selected destination.
      Effect.catchTag("PermissionHandoff.Conflict", (error) => {
        if (error.reason !== "receipt_mismatch") return Effect.fail(error)
        return Effect.promise(read).pipe(
          Effect.flatMap((current) => {
            if (current.authority !== before.authority)
              return Effect.die(new Error("native project permission binding mismatch"))
            return prepare(current)
          }),
        )
      }),
    ),
  )
  const after = Schema.decodeUnknownSync(Snapshot)(
    await input.client.request("handoff", {
      authority: prepared.authority,
      rules: prepared.rules,
    }),
  )
  if (
    after.authority !== prepared.authority ||
    after.project !== input.projectID ||
    after.revision < before.revision ||
    !after.migration
  )
    throw new Error("native project permission handoff result binding mismatch")
  await Effect.runPromise(
    PermissionHandoff.complete(input.db, {
      projectID: input.projectID,
      authority: after.authority,
      receipt: { ...after.migration },
    }),
  )
  return after
}
