import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261017014113_session_account_pin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`credential_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
