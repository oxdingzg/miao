export * as SessionLegacyTables from "./legacy-tables"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

/**
 * Whether the legacy V1 `message` / `part` tables still exist. `miao db compact`
 * drops them once every legacy message has a V2 projection, so every reader and
 * the projector have to treat their absence as "no legacy history" rather than
 * querying tables that are gone. Probing per call keeps a long-lived process
 * (for example `miao serve` started before the drop) correct instead of caching
 * what was true at startup.
 */
export const present = (db: Pick<Database.Interface["db"], "get">) =>
  db
    .get<{ present: number }>(
      sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'message' LIMIT 1`,
    )
    .pipe(
      Effect.map((row) => row !== undefined),
      Effect.orDie,
    )
