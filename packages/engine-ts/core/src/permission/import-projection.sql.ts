import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Location } from "../location"
import type { PermissionImportProjection } from "./import-projection"

export const PermissionImportProjectionTable = sqliteTable("permission_import_replica", {
  owner_key: text().primaryKey(),
  location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
  directory: text().notNull(),
  cursor: integer().notNull(),
  migration: text({ mode: "json" }).$type<PermissionImportProjection.Migration>(),
  rules: text({ mode: "json" }).$type<readonly PermissionImportProjection.Rule[]>().notNull(),
})
