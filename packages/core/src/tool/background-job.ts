export * as BackgroundJobTool from "./background-job"

import { Effect, Schema } from "effect"
import { BackgroundJob } from "../background-job"
import { Tool, type AnyTool } from "./tool"

/** Caps a model-facing wait so a tool call cannot block a turn indefinitely. */
export const MAX_WAIT_MS = 600_000

export const JobInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }]

/**
 * Model-facing observation and control, owner-bound to one Session. The runner
 * combines live process jobs with durable lifecycle records; interrupted jobs
 * stay observable after restart without replaying commands.
 */
export const make = (api: {
  readonly list: () => Effect.Effect<ReadonlyArray<BackgroundJob.Info>>
  readonly wait: (id: string, timeoutMs?: number) => Effect.Effect<BackgroundJob.WaitResult>
  readonly cancel: (id: string) => Effect.Effect<BackgroundJob.Info | undefined>
}): Record<string, AnyTool> => ({
  job_list: Tool.withConcurrency(
    Tool.make({
      description: "List this session's managed background jobs and their status.",
      input: Schema.Struct({}),
      output: Schema.Struct({ jobs: Schema.Array(JobInfo) }),
      toModelOutput: ({ output }) => text(output.jobs),
      execute: () => api.list().pipe(Effect.map((jobs) => ({ jobs }))),
    }),
    "concurrent",
  ),
  // Waiting owns no workspace state and can block for the whole cap, so it must
  // not hold the turn's exclusive permit while it waits.
  job_wait: Tool.withConcurrency(
    Tool.make({
      description: `Wait for one of this session's background jobs to finish (max ${MAX_WAIT_MS} ms).`,
      input: Schema.Struct({ id: Schema.String, timeoutMs: Schema.optional(Schema.Number) }),
      output: Schema.Struct({ job: Schema.optional(JobInfo), timedOut: Schema.Boolean }),
      toModelOutput: ({ output }) => text(output),
      execute: ({ id, timeoutMs }) => {
        const capped = Math.min(Math.max(timeoutMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS)
        return api.wait(id, capped).pipe(Effect.map((result) => ({ job: result.info, timedOut: result.timedOut })))
      },
    }),
    "concurrent",
  ),
  job_cancel: Tool.make({
    description: "Cancel one of this session's running background jobs.",
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ job: Schema.optional(JobInfo) }),
    toModelOutput: ({ output }) => text(output),
    execute: ({ id }) => api.cancel(id).pipe(Effect.map((job) => ({ job }))),
  }),
})
