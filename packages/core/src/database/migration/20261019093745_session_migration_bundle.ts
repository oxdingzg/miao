import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019093745_session_migration_bundle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_migration\` ADD \`bundle\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
