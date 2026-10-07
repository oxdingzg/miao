import path from "path"
import { isMainThread, threadId } from "node:worker_threads"
import { DiagnosticFiles } from "@miao/core/diagnostic-files"
import { Global } from "@miao/core/global"
import { errorData } from "../util/error"

const MAX_BYTES = DiagnosticFiles.MiB
const BUDGET = {
  match: (name: string) => name === "crash.log" || name === "crash.log.previous",
  maxBytes: 2 * MAX_BYTES,
  maxFiles: 2,
}

/**
 * A process that dies from an uncaught error leaves nothing behind: the TUI's
 * console is the in-app console, and an uncaught error bypasses the top-level
 * try/catch in `index.ts`. Append a record next to the other diagnostics so a
 * flash exit is diagnosable after the fact instead of being a bare "it closed".
 */
export function recordCrash(kind: "uncaughtException" | "unhandledRejection", error: unknown) {
  const detail = errorData(error)
  const thread = isMainThread ? "main" : `worker-${threadId}`
  const line = `${new Date().toISOString()} pid=${process.pid} thread=${thread} ${kind} ${JSON.stringify(detail)}\n`
  DiagnosticFiles.append(path.join(Global.Path.log, "crash.log"), line, MAX_BYTES, BUDGET)
  process.stderr.write(`${kind}: ${detail.formatted}\n`)
}

/**
 * Bun's default is to print an uncaught error or rejection and exit(1). The
 * TUI's console is the in-app console, so that print is lost and a flash exit
 * leaves no trace: record both to disk instead. An uncaught exception leaves
 * the process in an unknown state and still exits. An unhandled rejection is
 * a missed error handler, not a corrupt process, so after recording it the
 * process keeps running — one dangling promise must not take down a
 * long-running TUI or the server its windows attach to.
 */
export function installFatalHandlers() {
  process.on("uncaughtException", (error) => {
    recordCrash("uncaughtException", error)
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => recordCrash("unhandledRejection", reason))
}

export * as Crash from "./crash"
