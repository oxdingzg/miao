import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101094802_great_hemingway",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_turn_usage\` ADD \`role\` text DEFAULT 'main' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_turn_usage\` ADD \`price_source\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
