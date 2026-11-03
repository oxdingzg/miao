import { eq } from "drizzle-orm"
import { SessionV1 } from "@miao/core/v1/session"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Database } from "@miao/core/database/database"
import { SessionBackfill } from "@miao/core/session/backfill"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { SessionV1Read } from "@miao/core/session/v1-read"
import { projectContext, type ProjectContext } from "../project-context"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@miao/core/fs-util"
import { Effect, Schema } from "effect"
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
    const ctx = yield* projectContext()
    if (args.file.startsWith("http://") || args.file.startsWith("https://"))
      return yield* fail("importing from a share URL is no longer supported; export the session to a file instead")
    const fs = yield* FSUtil.Service
    const archive = yield* fs
      .readJson(args.file)
      .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(args.file, error) })))
    const imported = yield* importArchive(archive, ctx).pipe(
      Effect.catchDefect((error) => fail(`Invalid session archive: ${error instanceof Error ? error.message : error}`)),
    )
    // Reading the result back is the only check that the archive arrived:
    // `importArchive` reports the id it wrote, not whether every message
    // landed. A projection that silently drops rows in the middle looks
    // identical to a complete one from the outside.
    const verified = yield* verifyImported(imported)
    process.stdout.write(`Imported session: ${imported}`)
    process.stdout.write(EOL)
    process.stdout.write(`  ${verified.messages} message(s), seq ${verified.firstSeq}..${verified.lastSeq}`)
    process.stdout.write(EOL)
    if (verified.gaps.length > 0) {
      process.stderr.write(`the projection has a gap in its sequence: ${verified.gaps.join(", ")}`)
      process.stderr.write(EOL)
      process.exitCode = 1
    }
  }),
})

/**
 * Writes an archive into the V2 projection under the current project. A
 * version 2 archive restores its `projection` as is; a V1 archive (no
 * `version`, or a sanitized one without `projection`) is mapped the way a
 * backfill maps legacy history, keeping what V2 has no field for under
 * `metadata.v1`. Nothing is written to the legacy tables.
 */
/**
 * Read an imported Session back and report what the projection actually holds.
 *
 * `importArchive` returns the id it wrote, which says nothing about whether
 * every message landed. A projection that drops rows in the middle looks
 * identical to a complete one from outside, so this counts them and reports a
 * gap in the sequence — the shape a partial write leaves behind.
 *
 * It does not compare contents against the archive. Detecting a row that landed
 * with the wrong body needs a per-message digest, which this change does not
 * add and does not claim.
 */
const verifyImported = (sessionID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make(sessionID)))
      .orderBy(SessionMessageTable.seq)
      .all()
      .pipe(Effect.orDie)
    const seqs = rows.map((row) => row.seq)
    const gaps: string[] = []
    for (let index = 1; index < seqs.length; index++) {
      const step = seqs[index] - seqs[index - 1]
      // Event-less projection rows sit at negative sequences and are not part
      // of the aggregate, so only a forward jump is a gap.
      if (step > 1 && seqs[index] > 0) gaps.push(`${seqs[index - 1]}->${seqs[index]}`)
    }
    return {
      messages: rows.length,
      firstSeq: seqs[0] ?? 0,
      lastSeq: seqs.at(-1) ?? 0,
      gaps,
    }
  })

export const importArchive = Effect.fn("Cli.import.archive")(function* (input: unknown, ctx: ProjectContext) {
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
