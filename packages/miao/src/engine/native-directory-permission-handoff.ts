import { Schema } from "effect"
import type { EngineClient } from "./client"
import type { Capabilities } from "./discovery"
import { NativePermissionPattern } from "./native-permission-pattern"

const Counter = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Binding = Schema.Struct({ project: Schema.String, directory: Schema.String, workspace_id: Schema.Null })
const Source = Schema.Struct({
  workspace: Schema.String,
  target: Schema.Struct({ authority: Schema.String, ...Binding.fields }),
  patterns: NativePermissionPattern.List.check(Schema.isMaxLength(512)),
  fingerprint: Schema.String,
  state: Schema.Literals(["prepared", "completed"]),
})
const Receipt = Schema.Struct({ fingerprint: Schema.String, imported: Counter })
const Context = Schema.Struct({
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

/** Explicit trusted-host handoff; the caller owns both model-free controls. */
export async function handoffNativeDirectoryPermissions(input: {
  projectID: string
  source: Pick<EngineClient, "request">
  destination: Pick<EngineClient, "request">
  capabilities: Pick<Capabilities, "permissionSourceHandoff" | "permissionContextStore" | "permissionContextHandoff">
}) {
  if (
    input.capabilities.permissionSourceHandoff !== 1 ||
    input.capabilities.permissionContextStore !== 1 ||
    input.capabilities.permissionContextHandoff !== 1
  )
    throw new Error("native directory permission handoff capabilities required before freezing source")
  const before = Schema.decodeUnknownSync(Context)(await input.destination.request("context_snapshot"))
  const binding = Schema.decodeUnknownSync(Binding)(await input.source.request("binding"))
  if (
    before.project.project !== input.projectID ||
    binding.project !== input.projectID ||
    binding.directory !== before.directory
  )
    throw new Error("native directory permission binding mismatch")
  const read = Schema.decodeUnknownSync(Schema.NullOr(Source))(await input.source.request("snapshot"))
  if (!read && before.migration) throw new Error("native directory destination receipt has no source record")
  if (read) {
    requireSource(read, before)
    if (before.migration) requireReceipt(read, before)
    if (read.state === "completed" && !before.migration)
      throw new Error("completed native directory handoff lost its destination receipt")
  }
  const prepared = Schema.decodeUnknownSync(Source)(
    await input.source.request("prepare", { authority: before.project.authority }),
  )
  requireSource(prepared, before)
  const after = Schema.decodeUnknownSync(Context)(
    await input.destination.request("context_handoff", {
      authority: prepared.target.authority,
      patterns: prepared.patterns,
    }),
  )
  requireSource(prepared, after)
  requireReceipt(prepared, after)
  if (after.revision < before.revision || after.project.revision < before.project.revision)
    throw new Error("native directory destination revision regressed")
  const completed = Schema.decodeUnknownSync(Source)(await input.source.request("complete", { snapshot: after }))
  requireSource(completed, after)
  requireReceipt(completed, after)
  if (completed.state !== "completed" || completed.fingerprint !== prepared.fingerprint)
    throw new Error("native directory source completion mismatch")
  return after
}

function requireSource(source: typeof Source.Type, destination: typeof Context.Type) {
  if (
    source.workspace !== destination.directory ||
    source.target.directory !== destination.directory ||
    source.target.project !== destination.project.project ||
    source.target.authority !== destination.project.authority ||
    source.patterns.some((pattern) => pattern.workspace !== source.workspace)
  )
    throw new Error("native directory source destination changed")
}

function requireReceipt(source: typeof Source.Type, destination: typeof Context.Type) {
  if (
    destination.migration?.fingerprint !== source.fingerprint ||
    destination.migration.imported !== source.patterns.length
  )
    throw new Error("native directory destination receipt mismatch")
}
