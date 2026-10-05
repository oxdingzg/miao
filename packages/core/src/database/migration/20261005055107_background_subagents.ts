import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005055107_background_subagents",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_delegation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`prompt_message_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`description\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`status\` text NOT NULL,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_delegation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_notification\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_notification_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_delegation_owner_status_idx\` ON \`session_delegation\` (\`session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_notification_pending_idx\` ON \`session_notification\` (\`session_id\`,\`promoted_seq\`,\`admitted_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
