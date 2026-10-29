import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import type { ProjectV2 } from "../project"
import type { PermissionHandoff } from "./handoff"

export const PermissionHandoffTable = sqliteTable("permission_handoff", {
  project_id: text()
    .$type<ProjectV2.ID>()
    .primaryKey()
    .references(() => ProjectTable.id),
  authority: text().notNull(),
  fingerprint: text().notNull(),
  rules: text({ mode: "json" }).$type<readonly PermissionHandoff.Rule[]>().notNull(),
  receipt: text({ mode: "json" }).$type<PermissionHandoff.Receipt>(),
})
