import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { SessionID } from "@miao/schema/session-id"
import type { Location } from "../location"

/** Product-side freeze survives a process crash. Terminal records retain the
 * exact retry identity; a second transition cannot replace a live one. */
export const SessionMigrationTable = sqliteTable(
  "session_migration",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull(),
    state: text().$type<"frozen" | "prepared" | "switched" | "completed" | "aborted">().notNull(),
    /** Which product authority the transfer moves to. Reverse transfers name
     * the native source in native_storage/location and carry the exported
     * payload in bundle. */
    direction: text().$type<"ts_to_rust" | "rust_to_ts">().notNull().default("ts_to_rust"),
    native_storage: text().notNull(),
    location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
    bundle_sha256: text().notNull(),
    /** Exact encoded semantic payload, committed with the freeze for recovery. */
    bundle: text(),
    source_seq: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check("session_migration_state", sql`${table.state} IN ('frozen','prepared','switched','completed','aborted')`),
    check("session_migration_watermark", sql`${table.source_seq} >= -1`),
    uniqueIndex("session_migration_active")
      .on(table.session_id)
      .where(sql`${table.state} NOT IN ('completed','aborted')`),
    index("session_migration_session").on(table.session_id),
  ],
)
