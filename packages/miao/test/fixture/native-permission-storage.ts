import type { Database } from "bun:sqlite"

/** The unchanged legacy snapshot contract spans the schema-23 SQL rename. */
export function projectedPermissionTable(database: Database) {
  const tables = database
    .query<
      { name: "engine_permission_rule" | "engine_permission_rule_legacy" },
      []
    >("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('engine_permission_rule','engine_permission_rule_legacy')")
    .all()
  if (tables.length !== 1) throw new Error("native permission fixture requires one supported projection table")
  return tables[0]!.name
}
