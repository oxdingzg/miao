export * as BlobSiblings from "./blob-siblings"

import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { SessionBlobGc } from "@miao/core/session/blob-gc"

export class SiblingScanError extends Schema.TaggedErrorClass<SiblingScanError>()(
  "@miao/Cli.BlobSiblingScanError",
  { file: Schema.String, cause: Schema.Defect() },
) {}

/** Mirrors the tables `SessionBlobGc.collect` scans; sibling databases are read raw. */
const SOURCE_COLUMNS = [
  ["session_message", "data"],
  ["event", "data"],
  ["session_input", "prompt"],
] as const satisfies ReadonlyArray<readonly [string, string]>

/**
 * The blob directory is shared by every channel database, so a blob is only
 * collectable when no sibling references it either. A source table an older
 * sibling does not have yet simply contributes no references; anything else
 * that prevents reading the file fails, so the caller can refuse to sweep
 * rather than risk deleting a live blob.
 */
export const collectReferences = (file: string) =>
  Effect.try({
    try: () => {
      const referenced = new Set<string>()
      const native = new NativeDatabase(file, { readonly: true })
      try {
        for (const [table, column] of SOURCE_COLUMNS) {
          let rows: Array<Record<string, unknown>>
          try {
            rows = native.query(`SELECT ${column} AS value FROM ${table}`).all() as Array<
              Record<string, unknown>
            >
          } catch (error) {
            if (error instanceof Error && error.message.includes("no such table")) continue
            throw error
          }
          for (const row of rows) SessionBlobGc.collectHashes(referenced, row.value)
        }
      } finally {
        native.close()
      }
      return referenced
    },
    catch: (cause) => new SiblingScanError({ file, cause }),
  })
