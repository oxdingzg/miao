import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261029033715_imported_permission_replica",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_import_replica\` (
          \`owner_key\` text PRIMARY KEY,
          \`location\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`cursor\` integer NOT NULL,
          \`migration\` text,
          \`rules\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
