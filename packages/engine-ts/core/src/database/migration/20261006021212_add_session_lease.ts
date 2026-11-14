import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006021212_add_session_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_lease\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch\` integer NOT NULL,
          \`holder\` text NOT NULL,
          \`build\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_lease_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_lease_expires_at_idx\` ON \`session_lease\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
