import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004190240_remote_control_operations",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`remote_operation\` (
          \`subject\` text NOT NULL,
          \`id\` text NOT NULL,
          \`method\` text NOT NULL,
          \`session_id\` text,
          \`project_id\` text,
          \`digest\` text NOT NULL,
          \`status\` text NOT NULL,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`remote_operation_pk\` PRIMARY KEY(\`subject\`, \`id\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`remote_operation_session_idx\` ON \`remote_operation\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
