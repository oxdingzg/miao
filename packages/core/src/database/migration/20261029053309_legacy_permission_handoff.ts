import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261029053309_legacy_permission_handoff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_handoff\` (
          \`project_id\` text PRIMARY KEY,
          \`authority\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`rules\` text NOT NULL,
          \`receipt\` text,
          CONSTRAINT \`fk_permission_handoff_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`)
        );
      `)
      yield* tx.run(`ALTER TABLE \`permission\` RENAME TO \`permission_legacy\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
