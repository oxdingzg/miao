export * as SessionBackgroundJobs from "./background-jobs"

import { and, asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema, Semaphore } from "effect"
import type { BackgroundJob } from "../background-job"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionMessageTable, SessionNotificationTable } from "./sql"

const Record = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  status: Schema.Literals(["started", "finished", "interrupted", "cancelled"]),
  outputPath: Schema.String.pipe(Schema.optional),
})
const decode = Schema.decodeUnknownOption(Record)

const INTERRUPTED =
  "Background command is no longer tracked by this runtime. Its outcome is unknown; inspect its output and side effects before retrying. It was not automatically restarted."

/** Durable observation, not execution recovery: shell side effects are never replayed. */
export const make = (input: {
  db: Database.Interface["db"]
  events: EventV2.Interface
  sessionID: SessionSchema.ID
  jobs?: BackgroundJob.Interface
}) => {
  const gate = Semaphore.makeUnsafe(1)
  const read = Effect.fn("SessionBackgroundJobs.read")(function* () {
    const rows = yield* input.db
      .select({
        record: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.metadata.backgroundJob')`.mapWith((value) =>
          Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value),
        ),
        text: sql<string>`json_extract(${SessionMessageTable.data}, '$.text')`,
        at: SessionMessageTable.time_created,
      })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.type, "synthetic"),
          sql`json_type(${SessionMessageTable.data}, '$.metadata.backgroundJob') = 'object'`,
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    // Settled jobs arrive as admitted notifications rather than transcript
    // lines, so their outcomes are durable in the notification table instead.
    const settled = yield* input.db
      .select({
        record: sql<unknown>`json_extract(${SessionNotificationTable.metadata}, '$.backgroundJob')`.mapWith((value) =>
          Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value),
        ),
        text: SessionNotificationTable.text,
        at: SessionNotificationTable.time_created,
      })
      .from(SessionNotificationTable)
      .where(
        and(
          eq(SessionNotificationTable.session_id, input.sessionID),
          sql`json_type(${SessionNotificationTable.metadata}, '$.backgroundJob') = 'object'`,
        ),
      )
      .orderBy(asc(SessionNotificationTable.admitted_seq))
      .all()
      .pipe(Effect.orDie)
    const jobs = new Map<string, BackgroundJob.Info>()
    for (const row of [...rows, ...settled]) {
      const parsed = Option.isSome(row.record) ? decode(row.record.value) : Option.none()
      if (Option.isNone(parsed)) continue
      const record = parsed.value
      const previous = jobs.get(record.id)
      // A generic finish notice racing cancellation cannot turn it into success.
      if (previous?.status === "cancelled" && record.status === "finished") continue
      jobs.set(record.id, {
        id: record.id,
        type: "bash",
        title: record.command,
        started_at: previous?.started_at ?? row.at,
        status:
          record.status === "started"
            ? "running"
            : record.status === "finished"
              ? "completed"
              : record.status === "cancelled"
                ? "cancelled"
                : "error",
        ...(record.status === "started" ? {} : { completed_at: row.at, output: row.text }),
        ...(record.status === "interrupted" ? { error: INTERRUPTED } : {}),
        metadata: { sessionID: input.sessionID, ...(record.outputPath ? { outputPath: record.outputPath } : {}) },
      })
    }
    return [...jobs.values()]
  })

  const recover = () =>
    gate.withPermit(
      Effect.gen(function* () {
        const saved = yield* read()
        yield* Effect.forEach(
          saved.filter((job) => job.status === "running"),
          (job) =>
            Effect.gen(function* () {
              const live = input.jobs ? yield* input.jobs.get(job.id) : undefined
              // The Session owns the identifier. A job in another Session cannot be observed or cancelled.
              if (live?.metadata?.sessionID === input.sessionID) return
              yield* input.events.publish(SessionEvent.Synthetic, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.make(`msg_background_recovery_${job.id}`),
                timestamp: yield* DateTime.now,
                text: `Background job ${job.id} interrupted. ${INTERRUPTED}${typeof job.metadata?.outputPath === "string" ? `\nCaptured output: ${job.metadata.outputPath}` : ""}`,
                metadata: {
                  backgroundJob: {
                    id: job.id,
                    command: job.title ?? "",
                    status: "interrupted",
                    ...(typeof job.metadata?.outputPath === "string" ? { outputPath: job.metadata.outputPath } : {}),
                  },
                },
              })
            }),
        )
      }),
    )

  // UI observation must not publish recovery events or resume execution.
  const observe = Effect.fn("SessionBackgroundJobs.observe")(function* () {
    const saved = yield* read()
    const live = input.jobs ? yield* input.jobs.list() : []
    return [
      ...new Map([
        ...saved.map((job) => [job.id, job] as const),
        ...live.filter((job) => job.metadata?.sessionID === input.sessionID).map((job) => [job.id, job] as const),
      ]).values(),
    ].map((job) =>
      job.status === "running" &&
      !live.some((item) => item.id === job.id && item.metadata?.sessionID === input.sessionID)
        ? { ...job, status: "error" as const, error: INTERRUPTED }
        : job,
    )
  })

  const list = Effect.fn("SessionBackgroundJobs.list")(function* () {
    yield* recover()
    return yield* observe()
  })

  return {
    recover,
    observe,
    list,
    wait: Effect.fn("SessionBackgroundJobs.wait")(function* (id: string, timeoutMs?: number) {
      const live = input.jobs ? yield* input.jobs.get(id) : undefined
      if (live?.metadata?.sessionID === input.sessionID && input.jobs)
        return yield* input.jobs.wait({ id, timeout: timeoutMs })
      return { info: (yield* list()).find((job) => job.id === id), timedOut: false }
    }),
    cancel: Effect.fn("SessionBackgroundJobs.cancel")(function* (id: string) {
      const live = input.jobs ? yield* input.jobs.get(id) : undefined
      if (live?.metadata?.sessionID === input.sessionID && input.jobs) {
        const cancelled = yield* input.jobs.cancel(id)
        if (cancelled?.status === "cancelled")
          yield* input.events.publish(SessionEvent.Synthetic, {
            sessionID: input.sessionID,
            messageID: SessionMessage.ID.make(`msg_background_cancel_${id}`),
            timestamp: yield* DateTime.now,
            text: `Background job ${id} cancelled.`,
            metadata: {
              backgroundJob: {
                id,
                command: cancelled.title ?? "",
                status: "cancelled",
                ...(typeof cancelled.metadata?.outputPath === "string"
                  ? { outputPath: cancelled.metadata.outputPath }
                  : {}),
              },
            },
          })
        return cancelled
      }
      return (yield* list()).find((job) => job.id === id)
    }),
  }
}
