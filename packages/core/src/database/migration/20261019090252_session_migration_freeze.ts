import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019090252_session_migration_freeze",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_migration\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`native_storage\` text NOT NULL,
          \`location\` text NOT NULL,
          \`bundle_sha256\` text NOT NULL,
          \`source_seq\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "session_migration_state" CHECK("state" IN ('frozen','prepared','switched','completed','aborted')),
          CONSTRAINT "session_migration_watermark" CHECK("source_seq" >= -1)
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_migration_active\` ON \`session_migration\` (\`session_id\`) WHERE "session_migration"."state" NOT IN ('completed','aborted');`,
      )
      yield* tx.run(`CREATE INDEX \`session_migration_session\` ON \`session_migration\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
