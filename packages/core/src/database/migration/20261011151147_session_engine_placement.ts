import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011151147_session_engine_placement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_engine_placement\` (
          \`session_id\` text PRIMARY KEY,
          \`engine\` text NOT NULL,
          \`native_storage\` text,
          \`location\` text,
          CONSTRAINT "session_engine_placement_engine" CHECK("engine" IN ('ts', 'rust')),
          CONSTRAINT "session_engine_placement_native" CHECK(("engine" = 'ts' AND "native_storage" IS NULL AND "location" IS NULL)
                OR ("engine" = 'rust' AND "native_storage" IS NOT NULL AND "location" IS NOT NULL))
        );
      `)
      yield* tx.run(`INSERT INTO session_engine_placement (session_id, engine) SELECT id, 'ts' FROM session;`)
    })
  },
} satisfies DatabaseMigration.Migration
