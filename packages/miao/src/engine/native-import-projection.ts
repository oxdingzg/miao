import { Effect, Schema, Semaphore } from "effect"
import type { Database } from "@miao/core/database/database"
import { PermissionImportProjection } from "@miao/core/permission/import-projection"
import { PermissionSaved } from "@miao/schema/permission-saved"
import type { EngineClient } from "./client"

const Cursor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Receipt = Schema.Struct({ project: Schema.String, fingerprint: Schema.String, imported: Cursor })
const Rule = Schema.Struct({
  id: Schema.String,
  rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
})
const Snapshot = Schema.Struct({
  workspace: Schema.String,
  cursor: Cursor,
  migration: Schema.NullOr(Receipt),
  rules: Schema.Array(Rule),
})
const Page = Schema.Struct({
  workspace: Schema.String,
  cursor: Cursor,
  has_more: Schema.Boolean,
  changes: Schema.Array(
    Schema.Struct({
      seq: Cursor,
      recorded_at_ms: Cursor,
      change: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("migrated"), receipt: Receipt, rules: Schema.Array(Rule) }),
        Schema.Struct({ kind: Schema.Literal("removed"), id: Schema.String, fingerprint: Schema.String }),
      ]),
    }),
  ),
})

/** Read-only adapter; it never admits a legacy-rule migration or authorizes tools. */
export function makeNativeImportProjection(database: Database.Interface) {
  const clients = new WeakMap<EngineClient, Map<string, { gate: Semaphore.Semaphore; ready: boolean }>>()
  return (client: EngineClient, owner: PermissionImportProjection.Owner) => {
    const owners = clients.get(client) ?? new Map<string, { gate: Semaphore.Semaphore; ready: boolean }>()
    clients.set(client, owners)
    const identity = JSON.stringify([owner.storage, owner.location.directory, owner.location.workspaceID ?? null])
    const state = owners.get(identity) ?? { gate: Semaphore.makeUnsafe(1), ready: false }
    owners.set(identity, state)
    const snapshot = Effect.gen(function* () {
      const value = Schema.decodeUnknownSync(Snapshot)(
        yield* Effect.promise(() => client.request("permission_import_snapshot")),
      )
      const result = {
        directory: value.workspace,
        cursor: value.cursor,
        migration: value.migration,
        rules: value.rules.map(rule),
      }
      yield* PermissionImportProjection.replace(database.db, owner, result)
      state.ready = true
      return result
    })
    return Effect.runPromise(
      state.gate.withPermit(
        Effect.gen(function* () {
          if (!state.ready) return yield* snapshot
          const before = yield* PermissionImportProjection.read(database.db, owner)
          if (!before) return yield* snapshot
          let after = before.cursor
          for (let index = 0; index < 8; index++) {
            const page = Schema.decodeUnknownSync(Page)(
              yield* Effect.promise(() => client.request("permission_import_changes", { after, limit: 256 })),
            )
            if (page.has_more && page.cursor <= after)
              return yield* new PermissionImportProjection.Conflict({ reason: "invalid_page" })
            const applied = yield* PermissionImportProjection.apply(database.db, owner, {
              directory: page.workspace,
              after,
              cursor: page.cursor,
              changes: page.changes.map(
                (entry): PermissionImportProjection.Change =>
                  entry.change.kind === "removed"
                    ? {
                        seq: entry.seq,
                        type: "removed",
                        id: PermissionSaved.ID.make(entry.change.id),
                        fingerprint: entry.change.fingerprint,
                      }
                    : {
                        seq: entry.seq,
                        type: "migrated",
                        migration: entry.change.receipt,
                        rules: entry.change.rules.map(rule),
                      },
              ),
            }).pipe(Effect.result)
            if (applied._tag === "Failure") return yield* snapshot
            if (!page.has_more)
              return yield* PermissionImportProjection.read(database.db, owner).pipe(Effect.map((value) => value!))
            after = page.cursor
          }
          return yield* snapshot
        }),
      ),
    )
  }
}

function rule(value: typeof Rule.Type) {
  return { id: PermissionSaved.ID.make(value.id), action: value.rule.action, resource: value.rule.resource }
}
