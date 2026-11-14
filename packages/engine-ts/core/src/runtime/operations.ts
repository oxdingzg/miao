import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { RemoteOperationTable } from "./operations.sql"

export type Record = typeof RemoteOperationTable.$inferSelect
export type Identity = Pick<Record, "subject" | "id" | "method" | "session_id" | "project_id" | "digest">

export const get = Effect.fn("RemoteOperations.get")(function* (
  db: Database.Interface["db"],
  subject: string,
  id: string,
) {
  return yield* db.select().from(RemoteOperationTable).where(key(subject, id)).get()
})

// Persist before any external effect. A retry can reconcile the stored receipt,
// but a prepared receipt alone never authorizes replaying provider/tool work.
export const prepare = Effect.fn("RemoteOperations.prepare")(function* (db: Database.Interface["db"], input: Identity) {
  const now = Date.now()
  const inserted = yield* db
    .insert(RemoteOperationTable)
    .values({ ...input, status: "prepared", time_created: now, time_updated: now })
    .onConflictDoNothing()
    .returning()
    .get()
  if (inserted) return { type: "created" as const, record: inserted }
  const existing = yield* get(db, input.subject, input.id)
  if (!existing) return yield* Effect.die(new Error("Remote operation disappeared during admission"))
  if (
    existing.digest !== input.digest ||
    existing.method !== input.method ||
    existing.session_id !== input.session_id ||
    existing.project_id !== input.project_id
  )
    return { type: "conflict" as const }
  return { type: "existing" as const, record: existing }
})

export const settle = Effect.fn("RemoteOperations.settle")(function* (
  db: Database.Interface["db"],
  subject: string,
  id: string,
  status: Exclude<Record["status"], "prepared">,
  result: unknown,
) {
  // Terminal receipts are immutable. In particular, late callbacks cannot
  // overwrite a completed operation after a reconnect has reconciled it.
  return yield* db
    .update(RemoteOperationTable)
    .set({ status, result, time_updated: Date.now() })
    .where(and(key(subject, id), eq(RemoteOperationTable.status, "prepared")))
    .returning()
    .get()
})

function key(subject: string, id: string) {
  return and(eq(RemoteOperationTable.subject, subject), eq(RemoteOperationTable.id, id))
}

export * as RemoteOperations from "./operations"
