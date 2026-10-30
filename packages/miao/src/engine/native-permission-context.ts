import { Schema } from "effect"
import { PermissionSaved } from "@miao/schema/permission-saved"
import { NativePermissionPattern } from "./native-permission-pattern"

const Counter = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Receipt = Schema.Struct({ fingerprint: Schema.String, imported: Counter })
export const Snapshot = Schema.Struct({
  project: Schema.Struct({
    authority: Schema.String,
    project: Schema.String,
    revision: Counter,
    migration: Schema.NullOr(Schema.Struct({ project: Schema.String, ...Receipt.fields })),
    rules: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        origin: Schema.Literals(["native", "legacy"]),
        rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
      }),
    ).check(Schema.isMaxLength(512)),
  }),
  directory: Schema.String,
  workspace_id: Schema.Null,
  revision: Counter,
  migration: Schema.NullOr(Receipt),
  patterns: NativePermissionPattern.List.check(Schema.isMaxLength(512)),
})

export const Cursor = Schema.Struct({ authority: Schema.String, seq: Counter })
export const Observation = Schema.Struct({ snapshot: Snapshot, cursor: Cursor })

export function saved(
  snapshot: typeof Snapshot.Type,
  projectID: PermissionSaved.Info["projectID"],
): PermissionSaved.Info[] {
  if (snapshot.project.project !== projectID) throw new Error("shared permission view project mismatch")
  return [
    ...snapshot.project.rules.map((record) => ({
      id: PermissionSaved.ID.make(record.id),
      projectID,
      action: record.rule.action,
      resource: record.rule.resource,
      ...(record.origin === "native" ? { origin: "native" as const } : {}),
    })),
    ...snapshot.patterns.map((pattern) => NativePermissionPattern.saved(pattern, projectID)),
  ]
}

export * as NativePermissionContext from "./native-permission-context"
