export * as SessionToolDispatch from "./tool-dispatch"

import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionToolDispatchTable } from "./sql"

export const Token = Schema.Struct({
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
  callID: Schema.String,
  id: Schema.String,
})
export type Token = typeof Token.Type

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("SessionToolDispatch.Rejected", {
  message: Schema.String,
}) {}

export function token(input: Omit<Token, "id">): Token {
  return { ...input, id: randomUUID() }
}

/** Called only from the Tool.Called event's transaction, never by replay projectors. */
export const plan = Effect.fn("SessionToolDispatch.plan")(function* (
  db: Database.Interface["db"],
  token: Token,
  call: { readonly tool: string; readonly input: Record<string, unknown> },
) {
  const rows = yield* db
    .insert(SessionToolDispatchTable)
    .values({
      session_id: token.sessionID,
      assistant_message_id: token.assistantMessageID,
      call_id: token.callID,
      token: token.id,
      tool: call.tool,
      input: call.input,
      status: "planned",
    })
    .onConflictDoNothing()
    .returning({ token: SessionToolDispatchTable.token })
    .all()
    .pipe(Effect.orDie)
  if (rows.length !== 1) return yield* new Rejected({ message: "Tool attempt already planned; refusing redispatch" })
})

/** One atomic consume immediately before invoking the local tool effect. */
export const consume = Effect.fn("SessionToolDispatch.consume")(function* (db: Database.Interface["db"], token: Token) {
  const rows = yield* db
    .update(SessionToolDispatchTable)
    .set({ status: "dispatched" })
    .where(
      and(
        identity(token),
        eq(SessionToolDispatchTable.token, token.id),
        eq(SessionToolDispatchTable.status, "planned"),
      ),
    )
    .returning({ token: SessionToolDispatchTable.token })
    .all()
    .pipe(Effect.orDie)
  if (rows.length !== 1)
    return yield* new Rejected({ message: "Tool attempt is not dispatchable; outcome may be unknown" })
})

/** Terminal events can retire authority, but can never mint or restore it. */
export const settle = (db: Database.Interface["db"], token: Omit<Token, "id">) =>
  db
    .update(SessionToolDispatchTable)
    .set({ status: "settled" })
    .where(and(identity(token), inArray(SessionToolDispatchTable.status, ["planned", "dispatched"])))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

export const recover = Effect.fn("SessionToolDispatch.recover")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        yield* db
          .update(SessionToolDispatchTable)
          .set({ status: "unknown" })
          .where(
            and(eq(SessionToolDispatchTable.session_id, sessionID), eq(SessionToolDispatchTable.status, "dispatched")),
          )
          .run()
        yield* db
          .update(SessionToolDispatchTable)
          .set({ status: "cancelled" })
          .where(
            and(eq(SessionToolDispatchTable.session_id, sessionID), eq(SessionToolDispatchTable.status, "planned")),
          )
          .run()
      }),
    )
    .pipe(Effect.orDie)
})

function identity(token: Omit<Token, "id">) {
  return and(
    eq(SessionToolDispatchTable.session_id, token.sessionID),
    eq(SessionToolDispatchTable.assistant_message_id, token.assistantMessageID),
    eq(SessionToolDispatchTable.call_id, token.callID),
  )
}
