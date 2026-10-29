export * as PermissionProjection from "./projection"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import { PermissionSaved } from "./saved"
import { PermissionProjectionCursorTable, PermissionProjectionTable } from "./projection.sql"

type Db = Database.Interface["db"]
export type Owner = { storage: string; location: Location.Ref }
export type Rule = Pick<PermissionSaved.Info, "id" | "action" | "resource">
export type Change = { seq: number } & ({ type: "upsert"; rule: Rule } | { type: "remove"; id: PermissionSaved.ID })
export type Snapshot = { directory: string; cursor: number; rules: readonly Rule[] }

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("PermissionProjection.Conflict", {
  reason: Schema.Literals(["invalid_snapshot", "invalid_page", "scope_mismatch", "cursor_mismatch"]),
}) {}

/** A snapshot replaces one owner's replica and cursor together, including emptiness. */
export const replace = Effect.fn("PermissionProjection.replace")(function* (db: Db, owner: Owner, input: Snapshot) {
  if (
    !cursor(input.cursor) ||
    !input.directory ||
    input.rules.length > 256 ||
    !input.rules.every(rule) ||
    new Set(input.rules.map((item) => item.id)).size !== input.rules.length
  )
    return yield* new Conflict({ reason: "invalid_snapshot" })
  const id = key(owner)
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(PermissionProjectionCursorTable)
          .values({ owner_key: id, location: owner.location, directory: input.directory, cursor: input.cursor })
          .onConflictDoUpdate({
            target: PermissionProjectionCursorTable.owner_key,
            set: { location: owner.location, directory: input.directory, cursor: input.cursor },
          })
          .run()
        yield* tx.delete(PermissionProjectionTable).where(eq(PermissionProjectionTable.owner_key, id)).run()
        if (input.rules.length)
          yield* tx
            .insert(PermissionProjectionTable)
            .values(
              input.rules.map((item) => ({ owner_key: id, id: item.id, action: item.action, resource: item.resource })),
            )
            .run()
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Replay in event order, then commit the new cursor in the same transaction. */
export const apply = Effect.fn("PermissionProjection.apply")(function* (
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
      (change, index) =>
        !cursor(change.seq) ||
        change.seq <= (input.changes[index - 1]?.seq ?? input.after) ||
        (change.type === "upsert" ? !rule(change.rule) : !change.id.startsWith(PermissionSaved.NativePrefix)),
    ) ||
    (input.changes.at(-1)?.seq ?? input.after) !== input.cursor
  )
    return yield* new Conflict({ reason: "invalid_page" })
  const id = key(owner)
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const before = yield* tx
          .select()
          .from(PermissionProjectionCursorTable)
          .where(eq(PermissionProjectionCursorTable.owner_key, id))
          .get()
        if (!before || before.cursor !== input.after) return yield* new Conflict({ reason: "cursor_mismatch" })
        if (before.directory !== input.directory) return yield* new Conflict({ reason: "scope_mismatch" })
        for (const change of input.changes) {
          if (change.type === "remove") {
            yield* tx
              .delete(PermissionProjectionTable)
              .where(and(eq(PermissionProjectionTable.owner_key, id), eq(PermissionProjectionTable.id, change.id)))
              .run()
            continue
          }
          yield* tx
            .insert(PermissionProjectionTable)
            .values({ owner_key: id, id: change.rule.id, action: change.rule.action, resource: change.rule.resource })
            .onConflictDoUpdate({
              target: [PermissionProjectionTable.owner_key, PermissionProjectionTable.id],
              set: { action: change.rule.action, resource: change.rule.resource },
            })
            .run()
        }
        const count = yield* tx
          .select({ id: PermissionProjectionTable.id })
          .from(PermissionProjectionTable)
          .where(eq(PermissionProjectionTable.owner_key, id))
          .all()
        if (count.length > 256) return yield* new Conflict({ reason: "invalid_page" })
        yield* tx
          .update(PermissionProjectionCursorTable)
          .set({ cursor: input.cursor })
          .where(eq(PermissionProjectionCursorTable.owner_key, id))
          .run()
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const read = Effect.fn("PermissionProjection.read")(function* (db: Db, owner: Owner) {
  const id = key(owner)
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const state = yield* tx
          .select()
          .from(PermissionProjectionCursorTable)
          .where(eq(PermissionProjectionCursorTable.owner_key, id))
          .get()
        if (!state) return undefined
        const rules = yield* tx
          .select({
            id: PermissionProjectionTable.id,
            action: PermissionProjectionTable.action,
            resource: PermissionProjectionTable.resource,
          })
          .from(PermissionProjectionTable)
          .where(eq(PermissionProjectionTable.owner_key, id))
          .all()
        return { directory: state.directory, cursor: state.cursor, rules } satisfies Snapshot
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

function key(owner: Owner) {
  return JSON.stringify([owner.storage, owner.location.directory, owner.location.workspaceID ?? null])
}

function cursor(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

function rule(value: Rule) {
  return (
    value.id.startsWith(PermissionSaved.NativePrefix) &&
    value.action.length > 0 &&
    value.action.length <= 1024 &&
    value.resource.length <= 8192
  )
}
