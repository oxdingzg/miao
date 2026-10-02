import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionTable } from "@miao/core/session/sql"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { InstanceRef } from "@/effect/instance-ref"
import { and, desc, eq, isNull } from "drizzle-orm"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@miao/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { EOL } from "os"
import path from "path"
import { which } from "@miao/core/util/which"

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
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionDeleteCommand).demandCommand(),
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
    const ctx = yield* InstanceRef
    if (!ctx) return
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
