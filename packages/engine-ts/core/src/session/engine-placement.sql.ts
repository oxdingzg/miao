import { sqliteTable, text, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { SessionID } from "@miao/schema/session-id"
import type { Location } from "../location"

/** Product routing authority; native transcript facts stay in native storage. */
export const SessionEnginePlacementTable = sqliteTable(
  "session_engine_placement",
  {
    session_id: text().$type<SessionID>().primaryKey(),
    engine: text().$type<"ts" | "rust">().notNull(),
    native_storage: text(),
    location: text({ mode: "json" }).$type<Location.Ref>(),
  },
  (table) => [
    check("session_engine_placement_engine", sql`${table.engine} IN ('ts', 'rust')`),
    check(
      "session_engine_placement_native",
      sql`(${table.engine} = 'ts' AND ${table.native_storage} IS NULL AND ${table.location} IS NULL)
        OR (${table.engine} = 'rust' AND ${table.native_storage} IS NOT NULL AND ${table.location} IS NOT NULL)`,
    ),
  ],
)
