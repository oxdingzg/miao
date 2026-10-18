import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261018114612_session_tool_dispatch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tool_dispatch\` (
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`token\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`input\` text NOT NULL,
          \`status\` text NOT NULL,
          CONSTRAINT \`session_tool_dispatch_pk\` PRIMARY KEY(\`session_id\`, \`assistant_message_id\`, \`call_id\`),
          CONSTRAINT \`fk_session_tool_dispatch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
