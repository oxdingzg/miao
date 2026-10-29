import { Schema } from "effect"
import { PermissionSaved } from "@miao/schema/permission-saved"

export const Pattern = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^prule_[a-f0-9]{64}$/)),
  workspace: Schema.String,
  source: Schema.Literal("native"),
  rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
  created_at_ms: Schema.Number,
})
export const List = Schema.Array(Pattern)

export function saved(
  pattern: typeof Pattern.Type,
  projectID: PermissionSaved.Info["projectID"],
): PermissionSaved.Info {
  return {
    id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${pattern.id}`),
    projectID,
    action: pattern.rule.action,
    resource: pattern.rule.resource,
    origin: "native",
    scope: { type: "directory", directory: pattern.workspace },
  }
}

export * as NativePermissionPattern from "./native-permission-pattern"
