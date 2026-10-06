export * as MonitorTool from "./monitor"

import { ToolFailure } from "@miao/llm"
import { ChildProcess } from "effect/unstable/process"
import { DateTime, Duration, Effect, Layer, Option, Ref, Result, Schema, Stream } from "effect"
import { BackgroundJob } from "../background-job"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Identifier } from "../id/id"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import { PositiveInt } from "../schema"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "monitor"
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
/** Documented ceiling for an explicit `timeoutMs`. */
export const MAX_TIMEOUT_MS = 60 * 60 * 1_000
/** Matching lines are collected for this long before one notice is published. */
export const BATCH_WINDOW_MS = 200
/** Most lines one notice may carry, however fast the command writes them. */
export const MAX_LINES_PER_NOTICE = 200
/** Notices one monitor may publish before further output is suppressed. */
export const MAX_NOTICES = 64
/** Largest notice text in UTF-8 bytes. */
export const MAX_NOTICE_BYTES = 8 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to run in the background" }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "Short human label used in the notice text and the background job title",
  }),
  pattern: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Regular expression a stdout line must match to be delivered. Omit it and every non-empty line is delivered.",
  }),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `How long the command may run, in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}; on expiry the job is cancelled.`,
    }),
})

export const StructuredOutput = Schema.Struct({
  jobID: Schema.String,
  description: Schema.String.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
})

export type Output = typeof Output.Type

const DESCRIPTION = [
  "Run one shell command in the background and deliver each matching stdout line as a synthetic notification when it arrives, re-invoking you instead of making you poll.",
  "It runs in the active Location with the default shell (/bin/sh on POSIX, COMSPEC on Windows).",
  `Matching lines are batched (about ${BATCH_WINDOW_MS} ms per notice); at most ${MAX_NOTICES} notices are published per monitor and each notice is capped at ${MAX_NOTICE_BYTES} bytes.`,
  `The command runs for at most timeoutMs (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}); when it elapses the job is cancelled and a final notice says so.`,
  "A final notice reports the exit code when the command ends. Returns immediately with a job id; do not poll for output. Inspect or cancel the job with job_list and job_cancel.",
].join(" ")

type MonitorMetadata = {
  readonly id: string
  readonly command: string
  readonly description?: string
}

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const compile = (pattern: string | undefined): Effect.Effect<RegExp | undefined, ToolFailure> =>
  pattern === undefined
    ? Effect.succeed(undefined)
    : Effect.try({
        try: () => new RegExp(pattern),
        catch: () => new ToolFailure({ message: `Invalid pattern: "${pattern}" is not a valid regular expression.` }),
      })

/** One notice never grows past the byte cap, even when a single line is huge. */
const boundNotice = (text: string) => {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_NOTICE_BYTES) return text
  const head = new TextDecoder().decode(bytes.subarray(0, MAX_NOTICE_BYTES), { stream: true })
  return `${head}\n[monitor output truncated at ${MAX_NOTICE_BYTES} bytes]`
}

const label = (monitor: MonitorMetadata) =>
  monitor.description === undefined ? monitor.id : `${monitor.id} (${monitor.description})`

/**
 * Drains the command's line stream, delivering matching lines in batches. The
 * stream owns the child's scope, so a timeout interrupts it and kills the
 * command. `okExitCodes: [0]` turns a non-zero exit into a typed failure that
 * still carries the code; a failure without a code means the command could not
 * start.
 */
const drain = (input: {
  readonly stream: Stream.Stream<string, AppProcess.AppProcessError>
  readonly matcher: RegExp | undefined
  readonly timeoutMs: number
  readonly publish: (lines: ReadonlyArray<string>) => Effect.Effect<void>
}) =>
  input.stream.pipe(
    Stream.filter((line) => input.matcher === undefined || input.matcher.test(line)),
    Stream.groupedWithin(MAX_LINES_PER_NOTICE, BATCH_WINDOW_MS),
    Stream.mapEffect(input.publish),
    Stream.runDrain,
    Effect.timeoutOption(input.timeoutMs),
    Effect.result,
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const appProcess = yield* AppProcess.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            jobID: output.jobID,
            ...(output.description === undefined ? {} : { description: output.description }),
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const jobs = yield* Effect.serviceOption(BackgroundJob.Service)
              const events = yield* Effect.serviceOption(EventV2.Service)
              if (Option.isNone(jobs) || Option.isNone(events))
                return yield* new ToolFailure({
                  message: "Background monitoring is not available in this runtime.",
                })
              const matcher = yield* compile(input.pattern)
              yield* permission.assert({
                action: name,
                resources: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const id = Identifier.ascending("job")
              const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
              const monitor: MonitorMetadata = {
                id,
                command: input.command,
                ...(input.description === undefined ? {} : { description: input.description }),
              }
              const announce = (text: string, metadata: Record<string, unknown>) =>
                Effect.gen(function* () {
                  yield* events.value.publish(SessionEvent.Synthetic, {
                    sessionID: context.sessionID,
                    messageID: SessionMessage.ID.create(),
                    timestamp: yield* DateTime.now,
                    text,
                    metadata,
                  })
                }).pipe(Effect.ignore)
              // Runs after the tool call has already returned, so a command that
              // cannot start is reported by the job and a final notice rather
              // than failing the call.
              const run = Effect.gen(function* () {
                const notices = yield* Ref.make(0)
                const suppressed = yield* Ref.make(false)
                const publish = (lines: ReadonlyArray<string>) =>
                  Effect.gen(function* () {
                    if (yield* Ref.get(suppressed)) return
                    const delivered = yield* Ref.updateAndGet(notices, (count) => count + 1)
                    if (delivered > MAX_NOTICES) {
                      yield* Ref.set(suppressed, true)
                      yield* announce(
                        `Monitor ${label(monitor)}: further matching output was suppressed after ${MAX_NOTICES} notices. The command keeps running; observe it with job_list.`,
                        { monitor },
                      )
                      return
                    }
                    yield* announce(boundNotice(lines.join("\n")), { monitor })
                  })
                const outcome = yield* drain({
                  stream: appProcess.runStream(
                    ChildProcess.make(input.command, [], {
                      shell: defaultShell(),
                      cwd: location.directory,
                      stdin: "ignore",
                      detached: process.platform !== "win32",
                      forceKillAfter: Duration.seconds(3),
                    }),
                    { okExitCodes: [0] },
                  ),
                  matcher,
                  timeoutMs,
                  publish,
                })
                const text = Result.isFailure(outcome)
                  ? outcome.failure.exitCode === undefined
                    ? `Monitor ${label(monitor)} could not start.\n${outcome.failure.message}`
                    : `Monitor ${label(monitor)} finished: the command exited with code ${outcome.failure.exitCode}.`
                  : Option.isNone(outcome.success)
                    ? `Monitor ${label(monitor)} timed out after ${timeoutMs} ms and the command was cancelled.`
                    : `Monitor ${label(monitor)} finished: the command exited with code 0.`
                yield* announce(text, { monitor })
                return text
              })
              yield* jobs.value.start({
                id,
                type: name,
                title: input.description ?? input.command,
                metadata: { sessionID: context.sessionID, monitor },
                run,
              })
              return {
                jobID: id,
                ...(input.description === undefined ? {} : { description: input.description }),
                output: `Monitoring started as job ${id}. Matching output lines arrive as synthetic notifications; do not poll. Inspect or cancel the job with job_list and job_cancel.`,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to start monitoring: ${input.command}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/monitor",
  layer,
  deps: [ToolRegistry.node, AppProcess.node, Location.node, PermissionV2.node],
})
