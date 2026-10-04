import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Independent of Session lifetime: deleting a Session must not make a remote
// operation ID reusable or erase evidence that an input was admitted.
export const RemoteOperationTable = sqliteTable(
  "remote_operation",
  {
    subject: text().notNull(),
    id: text().notNull(),
    method: text().notNull(),
    session_id: text(),
    project_id: text(),
    digest: text().notNull(),
    status: text().$type<"prepared" | "accepted" | "completed" | "rejected" | "outcome_unknown">().notNull(),
    result: text({ mode: "json" }).$type<unknown>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subject, table.id] }),
    index("remote_operation_session_idx").on(table.session_id),
  ],
)
