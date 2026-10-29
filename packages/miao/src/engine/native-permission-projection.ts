import { Effect, Schema, Semaphore } from "effect"
import type { Database } from "@miao/core/database/database"
import { PermissionProjection } from "@miao/core/permission/projection"
import { PermissionSaved } from "@miao/schema/permission-saved"
import type { EngineClient } from "./client"
import { NativePermissionPattern } from "./native-permission-pattern"

const Cursor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Snapshot = Schema.Struct({ workspace: Schema.String, cursor: Cursor, patterns: NativePermissionPattern.List })
const Page = Schema.Struct({
  workspace: Schema.String,
  cursor: Cursor,
  changes: Schema.Array(
    Schema.Struct({
      seq: Cursor,
      change: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("upsert"), pattern: NativePermissionPattern.Pattern }),
        Schema.Struct({ kind: Schema.Literal("remove"), id: NativePermissionPattern.Pattern.fields.id }),
      ]),
      recorded_at_ms: Schema.Number,
    }),
  ),
  has_more: Schema.Boolean,
})

/** Every new transport bootstraps atomically; subsequent reads replay durable deltas. */
export function makeNativePermissionProjection(database: Database.Interface) {
  const clients = new WeakMap<EngineClient, Map<string, { gate: Semaphore.Semaphore; ready: boolean }>>()
  return (client: EngineClient, owner: PermissionProjection.Owner) => {
    const owners = clients.get(client) ?? new Map<string, { gate: Semaphore.Semaphore; ready: boolean }>()
    clients.set(client, owners)
    const identity = JSON.stringify([owner.storage, owner.location.directory, owner.location.workspaceID ?? null])
    const state = owners.get(identity) ?? { gate: Semaphore.makeUnsafe(1), ready: false }
    owners.set(identity, state)
    const snapshot = Effect.gen(function* () {
      const value = Schema.decodeUnknownSync(Snapshot)(
        yield* Effect.promise(() => client.request("permission_pattern_snapshot")),
      )
      if (value.patterns.some((pattern) => pattern.workspace !== value.workspace))
        return yield* new PermissionProjection.Conflict({ reason: "scope_mismatch" })
      const result = {
        directory: value.workspace,
        cursor: value.cursor,
        rules: value.patterns.map((pattern) => ({
          id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${pattern.id}`),
          action: pattern.rule.action,
          resource: pattern.rule.resource,
        })),
      }
      yield* PermissionProjection.replace(database.db, owner, result)
      state.ready = true
      return result
    })
    return Effect.runPromise(
      state.gate.withPermit(
        Effect.gen(function* () {
          if (!state.ready) return yield* snapshot
          const before = yield* PermissionProjection.read(database.db, owner)
          if (!before) return yield* snapshot
          let after = before.cursor
          for (let index = 0; index < 8; index++) {
            const page = Schema.decodeUnknownSync(Page)(
              yield* Effect.promise(() => client.request("permission_pattern_changes", { after, limit: 256 })),
            )
            if (page.has_more && page.cursor <= after)
              return yield* new PermissionProjection.Conflict({ reason: "invalid_page" })
            if (
              page.changes.some(
                (entry) => entry.change.kind === "upsert" && entry.change.pattern.workspace !== page.workspace,
              )
            )
              return yield* new PermissionProjection.Conflict({ reason: "scope_mismatch" })
            const applied = yield* PermissionProjection.apply(database.db, owner, {
              directory: page.workspace,
              after,
              cursor: page.cursor,
              changes: page.changes.map(
                (entry): PermissionProjection.Change =>
                  entry.change.kind === "remove"
                    ? {
                        seq: entry.seq,
                        type: "remove",
                        id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${entry.change.id}`),
                      }
                    : {
                        seq: entry.seq,
                        type: "upsert",
                        rule: {
                          id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${entry.change.pattern.id}`),
                          action: entry.change.pattern.rule.action,
                          resource: entry.change.pattern.rule.resource,
                        },
                      },
              ),
            }).pipe(Effect.result)
            if (applied._tag === "Failure") return yield* snapshot
            if (!page.has_more)
              return yield* PermissionProjection.read(database.db, owner).pipe(Effect.map((value) => value!))
            after = page.cursor
          }
          // Bound work under continuous mutation, then refresh from one native read transaction.
          return yield* snapshot
        }),
      ),
    )
  }
}
