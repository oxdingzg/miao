import { SessionV1 } from "@miao/core/v1/session"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Database } from "@miao/core/database/database"
import { SessionBackfill } from "@miao/core/session/backfill"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionTable } from "@miao/core/session/sql"
import { SessionV1Read } from "@miao/core/session/v1-read"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@miao/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { ARCHIVE_VERSION } from "./export"

const decodeSessionInfo = Schema.decodeUnknownSync(SessionV1.SessionInfo)
const decodeWithParts = Schema.decodeUnknownSync(SessionV1.WithParts)
const decodeProjected = Schema.decodeUnknownSync(SessionMessage.Message)

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from a JSON file written by `miao export`",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    if (args.file.startsWith("http://") || args.file.startsWith("https://"))
      return yield* fail("importing from a share URL is no longer supported; export the session to a file instead")
    const fs = yield* FSUtil.Service
    const archive = yield* fs
      .readJson(args.file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(args.file, error) })))
    const imported = yield* importArchive(archive, ctx).pipe(
      Effect.catchDefect((error) => fail(`Invalid session archive: ${error instanceof Error ? error.message : error}`)),
    )
    process.stdout.write(`Imported session: ${imported}`)
    process.stdout.write(EOL)
  }),
})

/**
 * Writes an archive into the V2 projection under the current project. A
 * version 2 archive restores its `projection` as is; a V1 archive (no
 * `version`, or a sanitized one without `projection`) is mapped the way a
 * backfill maps legacy history, keeping what V2 has no field for under
 * `metadata.v1`. Nothing is written to the legacy tables.
 */
export const importArchive = Effect.fn("Cli.import.archive")(function* (input: unknown, ctx: InstanceContext) {
  const { db } = yield* Database.Service
  const archive = (typeof input === "object" && input !== null ? input : {}) as {
    version?: unknown
    info?: unknown
    messages?: unknown
    projection?: unknown
  }
  if (typeof archive.version === "number" && archive.version > ARCHIVE_VERSION)
    return yield* fail(`archive version ${archive.version} is newer than this miao supports (${ARCHIVE_VERSION})`)
  const source = decodeSessionInfo(archive.info)
  const messages = Array.isArray(archive.projection)
    ? archive.projection.map((message) => decodeProjected(message))
    : SessionV1Read.map(
        (Array.isArray(archive.messages) ? archive.messages : []).map(
          (message) => decodeWithParts(message) as SessionV1.WithParts,
        ),
        // Legacy patch paths are absolute under the directory the session ran in.
        { directory: source.directory },
      )
  const sessionID = SessionSchema.ID.make(source.id)
  const row = {
    id: sessionID,
    project_id: ctx.project.id,
    parent_id: source.parentID ? SessionSchema.ID.make(source.parentID) : undefined,
    slug: source.slug,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
    title: source.title,
    version: source.version,
    agent: source.agent,
    model: source.model,
    summary_additions: source.summary?.additions,
    summary_deletions: source.summary?.deletions,
    summary_files: source.summary?.files,
    summary_diffs: source.summary?.diffs ? [...source.summary.diffs] : undefined,
    metadata: source.metadata,
    cost: source.cost ?? 0,
    tokens_input: source.tokens?.input ?? 0,
    tokens_output: source.tokens?.output ?? 0,
    tokens_reasoning: source.tokens?.reasoning ?? 0,
    tokens_cache_read: source.tokens?.cache.read ?? 0,
    tokens_cache_write: source.tokens?.cache.write ?? 0,
    permission: source.permission ? [...source.permission] : undefined,
    time_created: source.time.created,
    time_updated: source.time.updated,
    time_archived: source.time.archived,
  }
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(SessionTable)
          .values(row as typeof SessionTable.$inferInsert)
          .onConflictDoUpdate({
            target: SessionTable.id,
            set: { project_id: row.project_id, directory: row.directory, path: row.path },
          })
          .run()
          .pipe(Effect.orDie)
        yield* SessionBackfill.write(tx, sessionID, messages)
      }),
    )
    .pipe(Effect.orDie)
  return sessionID
})
