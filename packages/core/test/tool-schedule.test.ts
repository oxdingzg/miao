import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@miao/core/agent"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchedule } from "@miao/core/session/schedule"
import { ScheduleTool } from "@miao/core/tool/schedule"
import { Tool } from "@miao/core/tool/tool"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const sessionID = SessionV2.ID.make("ses_schedule_tool")

const context: Tool.Context = {
  sessionID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_schedule_tool"),
  toolCallID: "call-schedule",
}

/** A stand-in for the process-global service the runtime root normally provides. */
const fake = (created: SessionSchedule.CreateInput[]) => {
  const jobs: SessionSchedule.Info[] = []
  const service = SessionSchedule.Service.of({
    create: (input) =>
      Effect.sync(() => {
        created.push(input)
        const info: SessionSchedule.Info = {
          id: `sched_${jobs.length}`,
          sessionID: input.sessionID,
          prompt: input.prompt,
          ...(input.cron === undefined ? {} : { expression: input.cron }),
          ...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
          recurring: input.recurring ?? false,
          createdAt: 0,
          nextAt: 1,
        }
        jobs.push(info)
        return info
      }),
    list: (id) => Effect.succeed(jobs.filter((job) => job.sessionID === id)),
    count: () => Effect.succeed(jobs.length),
    remove: () => Effect.succeed(true),
  })
  return service
}

const settle = (tool: string, input: unknown) =>
  Tool.settle(
    ScheduleTool.make()[tool]!,
    { type: "tool-call", id: `call-${tool}`, name: tool, input },
    context,
  )

describe("ScheduleTool", () => {
  it.effect("exposes the four scheduling tools", () =>
    Effect.sync(() => {
      expect(Object.keys(ScheduleTool.make()).toSorted()).toEqual([
        "cron_create",
        "cron_delete",
        "cron_list",
        "schedule_wakeup",
      ])
    }),
  )

  it.effect("reads the process-global schedule service at execution time", () =>
    Effect.gen(function* () {
      const created: SessionSchedule.CreateInput[] = []
      const result = yield* settle("cron_create", { prompt: "check the build", cron: "*/5 * * * *" }).pipe(
        Effect.provideService(SessionSchedule.Service, fake(created)),
      )
      expect(created).toHaveLength(1)
      expect(created[0]!.sessionID).toBe(sessionID)
      expect(created[0]!.prompt).toBe("check the build")
      expect(created[0]!.recurring).toBe(true)
      expect(result.structured).toMatchObject({ expression: "*/5 * * * *", recurring: true })
    }),
  )

  it.effect("fails clearly when the runtime does not provide scheduling", () =>
    Effect.gen(function* () {
      const error = yield* settle("cron_list", {}).pipe(Effect.flip)
      expect(error.message).toContain("not available")
    }),
  )

  it.effect("rejects a short delay and clamps a long one", () =>
    Effect.gen(function* () {
      const created: SessionSchedule.CreateInput[] = []
      const service = fake(created)
      const tooSoon = yield* settle("schedule_wakeup", { prompt: "x", delaySeconds: 5 }).pipe(
        Effect.provideService(SessionSchedule.Service, service),
        Effect.flip,
      )
      expect(tooSoon.message).toContain("at least 60")
      expect(created).toHaveLength(0)

      const result = yield* settle("schedule_wakeup", { prompt: "x", delaySeconds: 99_999 }).pipe(
        Effect.provideService(SessionSchedule.Service, service),
      )
      expect(created[0]!.delaySeconds).toBe(3600)
      expect(result.structured).toMatchObject({ delaySeconds: 3600 })
    }),
  )

  it.effect("deletes only jobs owned by the calling Session", () =>
    Effect.gen(function* () {
      const result = yield* settle("cron_delete", { id: "sched_missing" }).pipe(
        Effect.provideService(SessionSchedule.Service, fake([])),
      )
      expect(result.structured).toEqual({ removed: false })
    }),
  )
})
