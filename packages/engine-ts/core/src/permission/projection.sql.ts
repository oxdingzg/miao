import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Location } from "../location"
import type { PermissionSaved } from "./saved"

/** Read-only product replicas; permission evaluation never reads these tables. */
export const PermissionProjectionCursorTable = sqliteTable("permission_native_cursor", {
  owner_key: text().primaryKey(),
  location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
  directory: text().notNull(),
  cursor: integer().notNull(),
})

export const PermissionProjectionTable = sqliteTable(
  "permission_native_projection",
  {
    owner_key: text()
      .notNull()
      .references(() => PermissionProjectionCursorTable.owner_key, { onDelete: "cascade" }),
    id: text().$type<PermissionSaved.ID>().notNull(),
    action: text().notNull(),
    resource: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner_key, table.id] })],
)
