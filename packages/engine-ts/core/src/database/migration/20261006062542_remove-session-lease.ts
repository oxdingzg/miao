import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006062542_remove-session-lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_lease_expires_at_idx\`;`)
      yield* tx.run(`DROP TABLE \`session_lease\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
