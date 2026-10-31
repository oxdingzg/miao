export * as SessionGoal from "./goal"

import { and, desc, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionMessageTable } from "./sql"
import { SessionSchema } from "./schema"

/** A goal's lifecycle. `done` requires evidence; `blocked` names the blocker. */
export const Status = Schema.Literals(["active", "paused", "blocked", "done"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  objective: Schema.String.annotate({ description: "The outcome to achieve" }),
  status: Status.annotate({ description: "active, paused, blocked, or done" }),
  autonomous: Schema.optional(Schema.Boolean).annotate({
    description:
      "Records explicit user authorization for continued autonomous work. Continuation itself is todo-driven and does not require this flag; a goal that is not active stops it.",
  }),
  evidence: Schema.optional(Schema.String).annotate({
    description: "Concrete evidence the goal is met (for done), or the blocker (for blocked)",
  }),
  budget: Schema.optional(Schema.String).annotate({ description: "Optional budget or limit for the goal" }),
}).annotate({ identifier: "Session.Goal" })
export type Info = typeof Info.Type

/** Read the latest durable goal, including goals recorded before compaction. */
export const current = Effect.fn("SessionGoal.current")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ goal: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.goal')` })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "synthetic"),
        sql`json_type(${SessionMessageTable.data}, '$.metadata.goal') = 'object'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Info))(row.goal))
})
