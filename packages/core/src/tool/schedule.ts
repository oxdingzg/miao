export * as ScheduleTool from "./schedule"

import { ToolFailure } from "@miao/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchedule } from "../session/schedule"
import { ToolRegistry } from "./registry"
import { Tool, type AnyTool, type Context } from "./tool"
import { Tools } from "./tools"

/** Shortest delay or gap a schedule may use. */
export const MIN_DELAY_SECONDS = 60
/** Longest one-shot delay; longer requests are clamped down and the clamped value is reported. */
export const MAX_DELAY_SECONDS = 3600
/** Most scheduled jobs one Session may hold. */
export const MAX_JOBS_PER_SESSION = 8
/** Most scheduled jobs the whole process may hold. */
export const MAX_JOBS_PER_PROCESS = 64

const UNAVAILABLE = "Scheduling is not available in this runtime."

const NON_DURABLE = "Scheduled jobs live only for the lifetime of this process and are lost when miao restarts."

const time = (millis: number) => new Date(millis).toLocaleString()

export const CronCreateInput = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The prompt text delivered back into this Session, verbatim, when the schedule fires.",
  }),
  cron: Schema.String.annotate({
    description:
      "Standard 5-field cron expression: minute hour day-of-month month day-of-week, in local time. Supports *, a-b, */n, a-b/n, and comma-separated lists. The finest granularity is once per minute.",
  }),
  recurring: Schema.optional(Schema.Boolean).annotate({
    description: `Repeat at every matching time. Defaults to true. Recurring jobs stop automatically after 7 days. ${NON_DURABLE}`,
  }),
})

export const CronCreateOutput = Schema.Struct({
  id: Schema.String,
  expression: Schema.String,
  nextAt: Schema.Number,
  recurring: Schema.Boolean,
})

export const ScheduleEntry = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  expression: Schema.optional(Schema.String),
  delaySeconds: Schema.optional(Schema.Number),
  recurring: Schema.Boolean,
  nextAt: Schema.Number,
})

export const CronListOutput = Schema.Struct({
  jobs: Schema.Array(ScheduleEntry),
})

export const CronDeleteInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The job id returned by cron_create or schedule_wakeup." }),
})

export const CronDeleteOutput = Schema.Struct({
  removed: Schema.Boolean,
})

export const WakeupInput = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The prompt text delivered back into this Session when the timer fires." }),
  delaySeconds: Schema.Finite.annotate({
    description: `Seconds from now before the one-shot wakeup. Must be at least ${MIN_DELAY_SECONDS}; values above ${MAX_DELAY_SECONDS} are clamped to ${MAX_DELAY_SECONDS}.`,
  }),
})

export const WakeupOutput = Schema.Struct({
  id: Schema.String,
  delaySeconds: Schema.Number,
  nextAt: Schema.Number,
})

const CRON_CREATE_DESCRIPTION = [
  "Schedule a prompt to be delivered back into this Session at future times given by a standard 5-field cron expression (minute hour day-of-month month day-of-week), interpreted in local time.",
  "The prompt is admitted as a queued message and read when the Session would otherwise become idle.",
  `At most ${MAX_JOBS_PER_SESSION} jobs per Session and ${MAX_JOBS_PER_PROCESS} per process; recurring jobs stop after 7 days. ${NON_DURABLE}`,
].join(" ")

const CRON_LIST_DESCRIPTION = [
  "List the scheduled jobs owned by this Session, including each one's next fire time.",
  NON_DURABLE,
].join(" ")

const CRON_DELETE_DESCRIPTION = [
  "Delete one scheduled job owned by this Session.",
  `Pass the id returned by cron_create or schedule_wakeup. ${NON_DURABLE}`,
].join(" ")

const WAKEUP_DESCRIPTION = [
  "Schedule a one-shot prompt to be delivered back into this Session after a delay.",
  "The prompt is admitted as a queued message and read when the Session would otherwise become idle.",
  `Prefer schedule_wakeup when a job only needs to run once, and cron_create for anything repeating. ${NON_DURABLE}`,
].join(" ")

const SCHEDULE_ENTRY = (job: typeof ScheduleEntry.Type) =>
  [
    `${job.id} — next ${time(job.nextAt)}`,
    job.expression === undefined ? `in ${job.delaySeconds}s` : `cron "${job.expression}"`,
    job.recurring ? "recurring" : "one-shot",
    JSON.stringify(job.prompt),
  ].join(" ")

/**
 * Resolves the process-global schedule capability at execution time. It is
 * provided by the runtime root, not this Location's graph, so a Location cannot
 * declare it as a dependency without getting its own copy; reading it ambiently
 * is how built-ins reach process-global services (see the bash tool's use of
 * BackgroundJob).
 */
const scheduleService = Effect.gen(function* () {
  const schedule = yield* Effect.serviceOption(SessionSchedule.Service)
  if (Option.isNone(schedule)) return yield* new ToolFailure({ message: UNAVAILABLE })
  return schedule.value
})

const guardLimits = (context: Context, schedule: SessionSchedule.Interface) =>
  Effect.gen(function* () {
    const jobs = yield* schedule.list(context.sessionID)
    if (jobs.length >= MAX_JOBS_PER_SESSION)
      return yield* new ToolFailure({
        message: `This Session already has ${jobs.length} scheduled jobs, the limit. Delete one with cron_delete first.`,
      })
    if ((yield* schedule.count()) >= MAX_JOBS_PER_PROCESS)
      return yield* new ToolFailure({
        message: `This process already has ${MAX_JOBS_PER_PROCESS} scheduled jobs, the limit. Delete one with cron_delete first.`,
      })
  })

/** Builds the canonical scheduling tools. */
export const make = (): Record<string, AnyTool> => ({
  cron_create: Tool.make({
    description: CRON_CREATE_DESCRIPTION,
    input: CronCreateInput,
    output: CronCreateOutput,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text: `Scheduled job ${output.id} (${output.recurring ? "recurring" : "one-shot"}) next fires at ${time(output.nextAt)}. ${NON_DURABLE}`,
      },
    ],
    execute: (input, context) =>
      Effect.gen(function* () {
        const schedule = yield* scheduleService
        yield* guardLimits(context, schedule)
        const info = yield* schedule
          .create({ sessionID: context.sessionID, prompt: input.prompt, cron: input.cron, recurring: input.recurring ?? true })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        return { id: info.id, expression: input.cron, nextAt: info.nextAt, recurring: info.recurring }
      }),
  }),
  cron_list: Tool.withConcurrency(
    Tool.make({
      description: CRON_LIST_DESCRIPTION,
      input: Schema.Struct({}),
      output: CronListOutput,
      toModelOutput: ({ output }) => [
        {
          type: "text",
          text:
            output.jobs.length === 0 ? "No scheduled jobs for this Session." : output.jobs.map(SCHEDULE_ENTRY).join("\n"),
        },
      ],
      execute: (_input, context) =>
        Effect.gen(function* () {
          const schedule = yield* scheduleService
          const jobs = yield* schedule.list(context.sessionID)
          return {
            jobs: jobs.map((job) => ({
              id: job.id,
              prompt: job.prompt,
              ...(job.expression === undefined ? {} : { expression: job.expression }),
              ...(job.delaySeconds === undefined ? {} : { delaySeconds: job.delaySeconds }),
              recurring: job.recurring,
              nextAt: job.nextAt,
            })),
          }
        }),
    }),
    "concurrent",
  ),
  cron_delete: Tool.make({
    description: CRON_DELETE_DESCRIPTION,
    input: CronDeleteInput,
    output: CronDeleteOutput,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text: output.removed ? "Deleted the scheduled job." : "No scheduled job with that id belongs to this Session.",
      },
    ],
    execute: (input, context) =>
      Effect.gen(function* () {
        const schedule = yield* scheduleService
        const owned = (yield* schedule.list(context.sessionID)).some((job) => job.id === input.id)
        if (!owned) return { removed: false }
        return { removed: yield* schedule.remove(input.id) }
      }),
  }),
  schedule_wakeup: Tool.make({
    description: WAKEUP_DESCRIPTION,
    input: WakeupInput,
    output: WakeupOutput,
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text: `Scheduled one-shot wakeup ${output.id} in ${output.delaySeconds}s (at ${time(output.nextAt)}). ${NON_DURABLE}`,
      },
    ],
    execute: (input, context) =>
      Effect.gen(function* () {
        const schedule = yield* scheduleService
        if (input.delaySeconds < MIN_DELAY_SECONDS)
          return yield* new ToolFailure({
            message: `delaySeconds must be at least ${MIN_DELAY_SECONDS} (got ${input.delaySeconds}).`,
          })
        yield* guardLimits(context, schedule)
        const delaySeconds = Math.min(input.delaySeconds, MAX_DELAY_SECONDS)
        const info = yield* schedule
          .create({ sessionID: context.sessionID, prompt: input.prompt, delaySeconds, recurring: false })
          .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
        return { id: info.id, delaySeconds, nextAt: info.nextAt }
      }),
  }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools.register(make()).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/schedule",
  layer,
  deps: [ToolRegistry.node],
})
