import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006025925_session_wake_allowance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`wake_allowance\` integer DEFAULT 32 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
