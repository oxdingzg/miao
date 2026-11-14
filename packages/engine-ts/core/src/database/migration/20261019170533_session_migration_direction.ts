import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019170533_session_migration_direction",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_migration\` ADD \`direction\` text DEFAULT 'ts_to_rust' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
