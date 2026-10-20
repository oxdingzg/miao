import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionTable } from "@miao/core/session/sql"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { projectContext } from "../project-context"
import { and, desc, eq, isNull } from "drizzle-orm"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@miao/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { EOL } from "os"
import path from "path"
import { which } from "@miao/core/util/which"
import { Blob } from "@miao/core/blob"
import { EventV2 } from "@miao/core/event"
import { SessionStore } from "@miao/core/session/store"
import { SessionMigrationCoordinator } from "@miao/core/session/migration-coordinator"
import { SessionMigrationReverseCoordinator } from "@miao/core/session/migration-reverse-coordinator"
import { Snapshot } from "@miao/core/snapshot"
import { AbsolutePath } from "@miao/core/schema"
import { Model } from "@miao/schema/model"
import { Provider } from "@miao/schema/provider"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EngineClient } from "@/engine/client"
import { nativeEngineOptions } from "@/engine/native-engine"
import { engine as transferEngine } from "@/engine/transfer"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.MIAO_GIT_BASH_PATH) {
    const less = path.join(Flag.MIAO_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionDeleteCommand).command(SessionMigrateCommand).command(SessionMigrateBackCommand).demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    yield* removeSession(SessionV2.ID.make(args.sessionID)).pipe(
      Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
      Effect.catchTag("Session.NotFoundError", () => fail(`Session not found: ${args.sessionID}`)),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

/** Removes a session and its subagent sessions, which V2 does not delete with their parent. */
export const removeSession: (
  sessionID: SessionV2.ID,
) => Effect.Effect<void, SessionV2.NotFoundError, SessionV2.Service> = Effect.fnUntraced(function* (sessionID) {
  const sessions = yield* SessionV2.Service
  for (const child of yield* sessions.children(sessionID)) yield* removeSession(child.id)
  yield* sessions.remove(sessionID)
})

export const SessionMigrateCommand = effectCmd({
  command: "migrate <sessionID>",
  describe: "move a session from the TypeScript engine to the native engine",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to migrate",
        type: "string",
        demandOption: true,
      })
      .option("native-db", {
        describe: "native engine database to stage the Session into",
        type: "string",
        demandOption: true,
      })
      .option("workspace", {
        describe: "workspace root recorded for the native Session (defaults to the source location)",
        type: "string",
      })
      .option("protocol", {
        describe: "target wire protocol recorded for provider history (for example openai-chat)",
        type: "string",
        demandOption: true,
      })
      .option("model", {
        describe: "target model id (defaults to the source Session model)",
        type: "string",
      })
      .option("route", {
        describe: "native engine route binding",
        type: "string",
      })
      .option("agent", {
        describe: "agent name the native host manifest must match",
        type: "string",
      })
      .option("import-id", {
        describe: "durable import id reused by retries (defaults to native-<session>)",
        type: "string",
      })
      .option("bundle", {
        describe: "durable bundle file the native host reads (defaults beside the product database)",
        type: "string",
      }),
  handler: Effect.fn("Cli.session.migrate")(function* (args) {
    const sessionID = SessionV2.ID.make(args.sessionID)
    const options = nativeEngineOptions(process.env)
    if (!options)
      return yield* fail("Native engine binary not found; set MIAO_ENGINE_BIN or install a compatible engine")
    const nativeDatabase = path.resolve(args.nativeDb)
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const session = yield* store.get(sessionID)
      if (!session) return yield* fail(`Session not found: ${args.sessionID}`)
      const model = args.model ?? session.model?.id
      if (!model) return yield* fail("Pass --model: the source Session records no model to bind")
      const workspace = AbsolutePath.make(args.workspace ? path.resolve(args.workspace) : session.location.directory)
      const client = EngineClient.start({
        ...options,
        model,
        db: nativeDatabase,
        workspace,
      })
      try {
        const importID = args.importId ?? `native-${sessionID}`
        const completed = yield* SessionMigrationCoordinator.toNative({
          database: database.db,
          id: importID,
          sessionID,
          target: {
            engine: "rust",
            storage: AbsolutePath.make(nativeDatabase),
            location: { directory: workspace },
          },
          bundleFile: AbsolutePath.make(
            args.bundle
              ? path.resolve(args.bundle)
              : path.join(path.dirname(database.storage), "migrations", `${importID}.bundle.json`),
          ),
          productDatabase: AbsolutePath.make(database.storage),
          identity: { protocol: args.protocol, model },
          routeID: args.route,
          agent: args.agent === undefined ? undefined : { name: args.agent },
          engine: transferEngine(client),
        })
        UI.println(
          UI.Style.TEXT_SUCCESS_BOLD +
            `Session ${sessionID} migrated (${completed.state}) to ${nativeDatabase}` +
            UI.Style.TEXT_NORMAL,
        )
      } finally {
        client.close()
      }
    }).pipe(
      Effect.catch((error) => fail(`Migration failed: ${error instanceof Error ? error.message : String(error)}`)),
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            SessionV2.node,
            Database.node,
            EventV2.node,
            SessionStore.node,
            Blob.node,
            Snapshot.node,
            SessionExecution.node,
          ]),
          [[SessionExecution.node, SessionExecution.noopLayer]],
        ),
      ),
      Effect.scoped,
    )
  }),
})

export const SessionMigrateBackCommand = effectCmd({
  command: "migrate-back <sessionID>",
  describe: "move a session from the native engine back to the TypeScript engine",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to migrate back",
        type: "string",
        demandOption: true,
      })
      .option("native-db", {
        describe: "native engine database holding the active import",
        type: "string",
        demandOption: true,
      })
      .option("import-id", {
        describe: "durable import id used by the forward migration (defaults to native-<session>)",
        type: "string",
      })
      .option("agent", {
        describe: "agent name for replayed native turns (defaults to build)",
        type: "string",
      })
      .option("model", {
        describe: "model id for replayed native turns (defaults to the Session model)",
        type: "string",
      })
      .option("route", {
        describe: "native engine route binding",
        type: "string",
      }),
  handler: Effect.fn("Cli.session.migrateBack")(function* (args) {
    const sessionID = SessionV2.ID.make(args.sessionID)
    const options = nativeEngineOptions(process.env)
    if (!options) return yield* fail("Native engine binary not found; set MIAO_ENGINE_BIN or install a compatible engine")
    const nativeDatabase = path.resolve(args.nativeDb)
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const session = yield* store.get(sessionID)
      if (!session) return yield* fail(`Session not found: ${args.sessionID}`)
      const model = args.model ?? session.model?.id
      if (!model) return yield* fail("Pass --model: the Session records no model to bind")
      const importID = args.importId ?? `native-${sessionID}`
      const deltaFile = AbsolutePath.make(path.join(path.dirname(nativeDatabase), "migrations", `${importID}.delta.json`))
      const client = EngineClient.start({
        ...options,
        model,
        db: nativeDatabase,
        workspace: session.location.directory,
      })
      try {
        const completed = yield* SessionMigrationReverseCoordinator.toTypeScript({
          database: database.db,
          id: importID,
          sessionID,
          native: {
            engine: "rust",
            storage: AbsolutePath.make(nativeDatabase),
            location: { directory: AbsolutePath.make(session.location.directory) },
          },
          bundleFile: deltaFile,
          agent: args.agent ?? "build",
          model: { id: Model.ID.make(model), providerID: Provider.ID.make(options.provider ?? "unknown") },
          engine: {
            exportDelta: (input) =>
              Effect.tryPromise({
                try: () => client.request("transfer_export_delta", { import_id: input.importID, path: input.path }),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              }).pipe(
                Effect.map((value) => {
                  const receipt = value as Record<string, unknown>
                  return {
                    id: String(receipt.id),
                    session_id: String(receipt.session_id),
                    bundle_sha256: String(receipt.bundle_sha256),
                    baseline_seq: Number(receipt.baseline_seq),
                    timeline: (receipt.timeline as unknown[]) ?? [],
                  }
                }),
              ),
          },
        })
        UI.println(
          UI.Style.TEXT_SUCCESS_BOLD +
            `Session ${sessionID} migrated back (${completed.state}) to the TypeScript engine` +
            UI.Style.TEXT_NORMAL,
        )
      } finally {
        client.close()
      }
    }).pipe(
      Effect.catch((error) =>
        fail(`Migration back failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            SessionV2.node,
            Database.node,
            EventV2.node,
            SessionStore.node,
            Blob.node,
            Snapshot.node,
            SessionExecution.node,
          ]),
          [[SessionExecution.node, SessionExecution.noopLayer]],
        ),
      ),
      Effect.scoped,
    )
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const ctx = yield* projectContext()
    const { db } = yield* Database.Service
    const sessions = yield* db
      .select()
      .from(SessionTable)
      .where(
        and(
          eq(SessionTable.project_id, ctx.project.id),
          isNull(SessionTable.parent_id),
          isNull(SessionTable.time_archived),
        ),
      )
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(args.maxCount ?? 100)
      .all()
      .pipe(Effect.orDie)

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

type SessionRow = typeof SessionTable.$inferSelect

function formatSessionTable(sessions: SessionRow[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time_updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: SessionRow[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time_updated,
    created: session.time_created,
    projectId: session.project_id,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
