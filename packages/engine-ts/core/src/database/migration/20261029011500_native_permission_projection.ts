import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261029011500_native_permission_projection",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_native_cursor\` (
          \`owner_key\` text PRIMARY KEY,
          \`location\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`cursor\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission_native_projection\` (
          \`owner_key\` text NOT NULL,
          \`id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          CONSTRAINT \`permission_native_projection_pk\` PRIMARY KEY(\`owner_key\`, \`id\`),
          CONSTRAINT \`fk_permission_native_projection_owner_key_permission_native_cursor_owner_key_fk\` FOREIGN KEY (\`owner_key\`) REFERENCES \`permission_native_cursor\`(\`owner_key\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
