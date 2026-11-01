import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101090000_usage_attribution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_turn_usage\` ADD COLUMN \`role\` TEXT NOT NULL DEFAULT 'main';`)
      yield* tx.run(`ALTER TABLE \`session_turn_usage\` ADD COLUMN \`price_source\` TEXT;`)
    })
  },
} satisfies DatabaseMigration.Migration
