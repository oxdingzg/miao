import { Effect, Formatter, Logger, type LogLevel } from "effect"
import path from "path"
import { DiagnosticFiles } from "../diagnostic-files"
import { Global } from "../global"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

const MAX_FILE_BYTES = 5 * DiagnosticFiles.MiB
const LOG_BUDGET = {
  match: (name: string) => name === "miao.log" || name === "miao.log.previous",
  maxBytes: 15 * DiagnosticFiles.MiB,
  maxFiles: 3,
}

// Every file logger in this process shares one write chain: the diagnostic
// lease admits one writer at a time, so concurrent flushes must queue behind
// each other instead of racing it and dropping their lines.
let writes: Promise<unknown> = Promise.resolve()
function flushLines(file: string, lines: ReadonlyArray<string>) {
  const text = lines.join("\n") + "\n"
  writes = writes
    .then(() => DiagnosticFiles.appendAsync(file, text, MAX_FILE_BYTES, LOG_BUDGET))
    .catch(() => {})
  return writes
}

/**
 * One structured line for runtimes that do not carry the file logger, such as
 * the raw HTTP web-handler fork: Effect.log* there reaches the default console
 * logger, and inside a TUI that output is lost with the process. `file` exists
 * for tests; production callers append to the shared miao.log.
 */
export async function appendLine(
  level: "WARN" | "ERROR",
  message: string,
  fields: Record<string, unknown> = {},
  file: string = path.join(Global.Path.log, "miao.log"),
) {
  const line =
    [
      `timestamp=${new Date().toISOString()}`,
      `level=${level}`,
      `run=${runID}`,
      `message=${format(message)}`,
      ...Object.entries(fields).map(([key, value]) => `${key}=${format(value)}`),
    ].join(" ") + "\n"
  await DiagnosticFiles.appendAsync(file, line, MAX_FILE_BYTES, LOG_BUDGET).catch(() => {})
}

export function fileLogger(file = path.join(Global.Path.log, "miao.log"), id: string = runID) {
  // Batched like Logger.toFile with its one-second window; do not shrink the
  // window to 0, it causes high idle CPU usage. Flushing reopens the file
  // through the diagnostic budget on every batch, so size-based rotation is
  // safe across the release, source, and preview channels that share one log
  // directory - a held-open handle would keep writing into a renamed file.
  return Logger.batched(formatter(id), {
    window: 1_000,
    flush: (lines) => Effect.ignore(Effect.promise(() => flushLines(file, lines))),
  })
}

export const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function printLogs() {
  return process.env.MIAO_PRINT_LOGS === "1"
}

export function minimumLogLevel() {
  const value = process.env.MIAO_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export * as Logging from "./logging"
