export * as PermissionImportProjection from "./import-projection"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import { PermissionSaved } from "./saved"
import { PermissionImportProjectionTable } from "./import-projection.sql"

type Db = Database.Interface["db"]
export type Owner = { storage: string; location: Location.Ref }
export type Migration = { project: string; fingerprint: string; imported: number }
export type Rule = Pick<PermissionSaved.Info, "id" | "action" | "resource">
export type Snapshot = { directory: string; cursor: number; migration: Migration | null; rules: readonly Rule[] }
export type Change = { seq: number } & (
  | { type: "migrated"; migration: Migration; rules: readonly Rule[] }
  | { type: "removed"; id: PermissionSaved.ID; fingerprint: string }
)

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("PermissionImportProjection.Conflict", {
  reason: Schema.Literals([
    "invalid_snapshot",
    "invalid_page",
    "scope_mismatch",
    "cursor_mismatch",
    "duplicate_migration",
  ]),
}) {}

/** A read-only replica. Neither permission decisions nor legacy imports read it. */
export const replace = Effect.fn("PermissionImportProjection.replace")(function* (
  db: Db,
  owner: Owner,
  input: Snapshot,
) {
  if (!snapshot(input)) return yield* new Conflict({ reason: "invalid_snapshot" })
  yield* db
    .insert(PermissionImportProjectionTable)
    .values({
      owner_key: key(owner),
      location: owner.location,
      directory: input.directory,
      cursor: input.cursor,
      migration: input.migration,
      rules: input.rules.map((item) => ({ id: item.id, action: item.action, resource: item.resource })),
    })
    .onConflictDoUpdate({
      target: PermissionImportProjectionTable.owner_key,
      set: {
        location: owner.location,
        directory: input.directory,
        cursor: input.cursor,
        migration: input.migration,
        rules: input.rules.map((item) => ({ id: item.id, action: item.action, resource: item.resource })),
      },
    })
    .run()
    .pipe(Effect.orDie)
})

export const apply = Effect.fn("PermissionImportProjection.apply")(function* (
  db: Db,
  owner: Owner,
  input: {
    directory: string
    after: number
    cursor: number
    changes: readonly Change[]
  },
) {
  if (
    !cursor(input.after) ||
    !cursor(input.cursor) ||
    input.changes.length > 256 ||
    input.cursor < input.after ||
    input.changes.some(
      (change, index) => !cursor(change.seq) || change.seq <= (input.changes[index - 1]?.seq ?? input.after),
    ) ||
    (input.changes.at(-1)?.seq ?? input.after) !== input.cursor
  )
    return yield* new Conflict({ reason: "invalid_page" })
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const before = yield* tx
          .select()
          .from(PermissionImportProjectionTable)
          .where(eq(PermissionImportProjectionTable.owner_key, key(owner)))
          .get()
        if (!before || before.cursor !== input.after) return yield* new Conflict({ reason: "cursor_mismatch" })
        if (before.directory !== input.directory) return yield* new Conflict({ reason: "scope_mismatch" })
        const migrations = input.changes.flatMap((change, index) =>
          change.type === "migrated" ? [{ ...change, index }] : [],
        )
        if (migrations.length > 1 || migrations.some((item) => item.index !== 0 || before.migration !== null))
          return yield* new Conflict({ reason: "duplicate_migration" })
        const migration = migrations[0]?.migration ?? before.migration
        const rules = migrations[0]?.rules ?? before.rules
        if (
          !snapshot({ directory: input.directory, cursor: input.cursor, migration, rules }) ||
          (migrations[0] && migrations[0].migration.imported !== migrations[0].rules.length)
        )
          return yield* new Conflict({ reason: "invalid_page" })
        const removed = input.changes.flatMap((change) => (change.type === "removed" ? [change] : []))
        if (removed.some((change) => !id(change.id) || change.fingerprint !== migration?.fingerprint))
          return yield* new Conflict({ reason: "scope_mismatch" })
        const ids = new Set(removed.map((change) => change.id))
        yield* tx
          .update(PermissionImportProjectionTable)
          .set({
            cursor: input.cursor,
            migration,
            rules: rules
              .filter((item) => !ids.has(item.id))
              .map((item) => ({ id: item.id, action: item.action, resource: item.resource })),
          })
          .where(eq(PermissionImportProjectionTable.owner_key, key(owner)))
          .run()
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const read = Effect.fn("PermissionImportProjection.read")(function* (db: Db, owner: Owner) {
  const row = yield* db
    .select()
    .from(PermissionImportProjectionTable)
    .where(eq(PermissionImportProjectionTable.owner_key, key(owner)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const result = { directory: row.directory, cursor: row.cursor, migration: row.migration, rules: row.rules }
  if (!snapshot(result)) return yield* new Conflict({ reason: "invalid_snapshot" })
  return result
})

function key(owner: Owner) {
  return JSON.stringify([owner.storage, owner.location.directory, owner.location.workspaceID ?? null])
}
function cursor(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}
function id(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith(PermissionSaved.NativePrefix) &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}
function snapshot(value: Snapshot) {
  return (
    cursor(value.cursor) &&
    value.directory.length > 0 &&
    value.rules.length <= 256 &&
    value.rules.every(
      (item) => id(item.id) && item.action.length > 0 && item.action.length <= 1024 && item.resource.length <= 8192,
    ) &&
    new Set(value.rules.map((item) => item.id)).size === value.rules.length &&
    (value.migration === null
      ? value.rules.length === 0
      : value.migration.project.length > 0 &&
        value.migration.project.length <= 512 &&
        /^[a-f0-9]{64}$/.test(value.migration.fingerprint) &&
        cursor(value.migration.imported) &&
        value.migration.imported <= 256 &&
        value.migration.imported >= value.rules.length)
  )
}
