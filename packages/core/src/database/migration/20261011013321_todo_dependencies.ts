import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011013321_todo_dependencies",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`task_id\` text;`)
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`depends_on\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
