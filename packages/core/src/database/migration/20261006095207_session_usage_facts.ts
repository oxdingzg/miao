import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006095207_session_usage_facts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tool_usage\` (
          \`session_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_called\` integer NOT NULL,
          \`time_settled\` integer,
          CONSTRAINT \`session_tool_usage_pk\` PRIMARY KEY(\`session_id\`, \`call_id\`),
          CONSTRAINT \`fk_session_tool_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_turn_usage\` (
          \`event_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`model_provider\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`finish\` text NOT NULL,
          \`cost\` real NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`tokens_cache_write\` integer NOT NULL,
          \`ttft_ms\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_turn_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_tool_usage_tool_time_idx\` ON \`session_tool_usage\` (\`tool\`,\`time_called\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_turn_usage_session_time_idx\` ON \`session_turn_usage\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_turn_usage_model_time_idx\` ON \`session_turn_usage\` (\`model_provider\`,\`model_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
