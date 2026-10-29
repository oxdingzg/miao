export * as PermissionHandoff from "./handoff"

import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { ProjectV2 } from "../project"
import { PermissionTable } from "./sql"
import { PermissionHandoffTable } from "./handoff.sql"

type Db = Database.Interface["db"]
export type Rule = { id: string; rule: { action: string; resource: string; effect: "allow" } }
export type Receipt = { project: string; fingerprint: string; imported: number }
export type State = typeof PermissionHandoffTable.$inferSelect

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("PermissionHandoff.Conflict", {
  reason: Schema.Literals([
    "invalid_input",
    "destination_mismatch",
    "receipt_mismatch",
    "corrupt_source",
    "not_prepared",
  ]),
}) {}

/** Freeze before crossing databases. There is no unsafe abort after preparation. */
export const prepare = Effect.fn("PermissionHandoff.prepare")(function* (
  db: Db,
  input: { projectID: ProjectV2.ID; authority: string; existing?: Receipt | null },
) {
  if (!uuid(input.authority)) return yield* new Conflict({ reason: "invalid_input" })
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const before = yield* read(tx, input.projectID)
        if (before) {
          if (before.authority !== input.authority) return yield* new Conflict({ reason: "destination_mismatch" })
          if (
            input.existing !== undefined &&
            (input.existing === null
              ? before.receipt !== null
              : !matchesReceipt(input.projectID, before.fingerprint, before.rules.length, input.existing))
          )
            return yield* new Conflict({ reason: "receipt_mismatch" })
          return before
        }
        const rules = yield* source(tx, input.projectID)
        if (!valid(input.projectID, rules)) return yield* new Conflict({ reason: "invalid_input" })
        if (
          input.existing &&
          !matchesReceipt(input.projectID, fingerprint(input.projectID, rules), rules.length, input.existing)
        )
          return yield* new Conflict({ reason: "receipt_mismatch" })
        // Installing the guards and freezing the exact source is one SQL commit.
        for (const statement of guards) yield* tx.run(sql.raw(statement))
        const state = {
          project_id: input.projectID,
          authority: input.authority,
          fingerprint: fingerprint(input.projectID, rules),
          rules,
          receipt: null,
        }
        yield* tx.insert(PermissionHandoffTable).values(state).run()
        return state
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

/** Called only after the native project authority has durably accepted the input. */
export const complete = Effect.fn("PermissionHandoff.complete")(function* (
  db: Db,
  input: { projectID: ProjectV2.ID; authority: string; receipt: Receipt },
) {
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const before = yield* read(tx, input.projectID)
        if (!before) return yield* new Conflict({ reason: "not_prepared" })
        if (before.authority !== input.authority) return yield* new Conflict({ reason: "destination_mismatch" })
        if (
          input.receipt.project !== input.projectID ||
          input.receipt.fingerprint !== before.fingerprint ||
          input.receipt.imported !== before.rules.length
        )
          return yield* new Conflict({ reason: "receipt_mismatch" })
        if (before.receipt) return before
        yield* tx
          .update(PermissionHandoffTable)
          .set({ receipt: input.receipt })
          .where(eq(PermissionHandoffTable.project_id, input.projectID))
          .run()
        return { ...before, receipt: input.receipt }
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const read = Effect.fn("PermissionHandoff.read")(function* (db: Pick<Db, "select">, projectID: ProjectV2.ID) {
  const row = yield* db
    .select()
    .from(PermissionHandoffTable)
    .where(eq(PermissionHandoffTable.project_id, projectID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  if (
    !uuid(row.authority) ||
    !valid(row.project_id, row.rules) ||
    row.fingerprint !== fingerprint(row.project_id, row.rules) ||
    (row.receipt !== null &&
      (row.receipt.project !== row.project_id ||
        row.receipt.fingerprint !== row.fingerprint ||
        row.receipt.imported !== row.rules.length))
  )
    return yield* new Conflict({ reason: "corrupt_source" })
  const rules = yield* source(db, projectID)
  if (fingerprint(projectID, rules) !== row.fingerprint) return yield* new Conflict({ reason: "corrupt_source" })
  return row
})

/** Legacy callers must not continue authorizing from a frozen source. */
export const requireLegacy = Effect.fn("PermissionHandoff.requireLegacy")(function* (
  db: Pick<Db, "select">,
  projectID?: ProjectV2.ID,
) {
  const row = yield* db
    .select({ project_id: PermissionHandoffTable.project_id })
    .from(PermissionHandoffTable)
    .where(projectID ? eq(PermissionHandoffTable.project_id, projectID) : undefined)
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (row)
    return yield* Effect.die(
      new Error(
        "saved permissions require the native authority backend; resume the prepared handoff instead of using legacy rules",
      ),
    )
})

const source = Effect.fn("PermissionHandoff.source")(function* (db: Pick<Db, "select">, projectID: ProjectV2.ID) {
  const rows = yield* db
    .select()
    .from(PermissionTable)
    .where(eq(PermissionTable.project_id, projectID))
    .limit(257)
    .all()
    .pipe(Effect.orDie)
  return rows
    .map((row): Rule => ({ id: row.id, rule: { action: row.action, resource: row.resource, effect: "allow" } }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
})

function matchesReceipt(project: string, fingerprint: string, count: number, receipt: Receipt) {
  return receipt.project === project && receipt.fingerprint === fingerprint && receipt.imported === count
}
function uuid(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
}
function valid(project: string, rules: readonly Rule[]) {
  return (
    project.length > 0 &&
    Buffer.byteLength(project) <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(project) &&
    rules.length <= 256 &&
    rules.every(
      (item, index) =>
        item.id.length > 0 &&
        Buffer.byteLength(item.id) <= 512 &&
        !item.id.startsWith("psv_native_") &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(item.id) &&
        (index === 0 || Buffer.compare(Buffer.from(rules[index - 1]!.id), Buffer.from(item.id)) < 0) &&
        item.rule.effect === "allow" &&
        Buffer.byteLength(item.rule.action) <= 1024 &&
        Buffer.byteLength(item.rule.resource) <= 8192 &&
        !item.rule.action.includes("\0") &&
        !item.rule.resource.includes("\0"),
    )
  )
}
function fingerprint(project: string, rules: readonly Rule[]) {
  // Key order matches the native LegacyRule/Rule serde representation.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "project-permissions-v1",
        project,
        rules.map((item) => ({
          id: item.id,
          rule: { action: item.rule.action, resource: item.rule.resource, effect: "allow" },
        })),
      ]),
    )
    .digest("hex")
}

const guards = [
  "CREATE TRIGGER IF NOT EXISTS permission_handoff_insert BEFORE INSERT ON permission_legacy WHEN EXISTS(SELECT 1 FROM permission_handoff WHERE project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'saved permission ownership handoff prepared'); END",
  "CREATE TRIGGER IF NOT EXISTS permission_handoff_update BEFORE UPDATE ON permission_legacy WHEN EXISTS(SELECT 1 FROM permission_handoff WHERE project_id=OLD.project_id OR project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'saved permission ownership handoff prepared'); END",
  "CREATE TRIGGER IF NOT EXISTS permission_handoff_delete BEFORE DELETE ON permission_legacy WHEN EXISTS(SELECT 1 FROM permission_handoff WHERE project_id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'saved permission ownership handoff prepared'); END",
  "CREATE TRIGGER IF NOT EXISTS permission_handoff_immutable BEFORE UPDATE OF project_id,authority,fingerprint,rules ON permission_handoff BEGIN SELECT RAISE(ABORT,'saved permission handoff source is immutable'); END",
  "CREATE TRIGGER IF NOT EXISTS permission_handoff_retain BEFORE DELETE ON permission_handoff BEGIN SELECT RAISE(ABORT,'saved permission handoff cannot be forgotten'); END",
]
