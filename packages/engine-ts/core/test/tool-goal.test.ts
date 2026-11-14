import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionGoal } from "@miao/core/session/goal"
import { GoalTool } from "@miao/core/tool/goal"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("GoalTool", () => {
  it.effect("records a durable synthetic goal message that reaches context", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })

      yield* GoalTool.record(events, created.id, {
        objective: "Ship the release",
        status: "active",
        budget: "1 day",
      })

      expect(yield* session.context(created.id)).toMatchObject([
        {
          type: "synthetic",
          text: expect.stringContaining('<goal status="active">'),
          metadata: { goal: { objective: "Ship the release", status: "active", budget: "1 day" } },
        },
      ])
    }),
  )

  it.effect("reads the latest durable goal without losing the autonomous flag", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const created = yield* session.create({ location })
      yield* GoalTool.record(events, created.id, { objective: "Original", status: "active", autonomous: true })
      expect(yield* SessionGoal.current(database.db, created.id)).toMatchObject({ status: "active", autonomous: true })
      yield* GoalTool.record(events, created.id, { objective: "Paused", status: "paused", autonomous: false })
      expect(yield* SessionGoal.current(database.db, created.id)).toMatchObject({
        objective: "Paused",
        status: "paused",
        autonomous: false,
      })
      expect(GoalTool.render({ objective: "Continue", status: "active", autonomous: true })).toContain(
        "autonomous: true",
      )
    }),
  )

  it.effect("renders status, budget, and evidence", () =>
    Effect.sync(() => {
      const text = GoalTool.render({ objective: "Fix it", status: "blocked", evidence: "waiting on upstream" })
      expect(text).toContain('<goal status="blocked">')
      expect(text).toContain("Fix it")
      expect(text).toContain("evidence: waiting on upstream")
    }),
  )

  it.effect("orphanedTodos only flags open todos across a changed objective", () =>
    Effect.sync(() => {
      const prev = { objective: "Ship A", status: "active" as const }
      const next = { objective: "Ship B", status: "active" as const }
      const todos = [
        { id: "t1", content: "write", status: "pending", priority: "high" },
        { id: "t2", content: "test", status: "in_progress", priority: "medium" },
        { id: "t3", content: "done", status: "completed", priority: "low" },
        { id: "t4", content: "dropped", status: "cancelled", priority: "low" },
      ]
      const orphans = GoalTool.orphanedTodos(prev, next, todos)
      expect(orphans.map((todo) => todo.id)).toEqual(["t1", "t2"])
      // Same objective or no prior goal never orphans anything.
      expect(GoalTool.orphanedTodos(prev, { ...prev, status: "paused" }, todos)).toEqual([])
      expect(GoalTool.orphanedTodos(undefined, next, todos)).toEqual([])
    }),
  )

  it.effect("orphanCheck names the orphaned todos and is undefined otherwise", () =>
    Effect.sync(() => {
      const prev = { objective: "Ship A", status: "active" as const }
      const next = { objective: "Ship B", status: "active" as const }
      const message = GoalTool.orphanCheck(prev, next, [
        { id: "t1", content: "write the parser", status: "pending", priority: "high" },
      ])
      expect(message).toBeDefined()
      expect(message).toContain("Ship A")
      expect(message).toContain("t1: write the parser")
      expect(message).toContain("todowrite")
      // An unchanged objective, an all-settled list, or a first goal raises nothing.
      expect(
        GoalTool.orphanCheck(prev, { ...prev }, [{ id: "t1", content: "x", status: "pending", priority: "high" }]),
      ).toBeUndefined()
      expect(
        GoalTool.orphanCheck(prev, next, [{ id: "t1", content: "x", status: "completed", priority: "high" }]),
      ).toBeUndefined()
      expect(
        GoalTool.orphanCheck(undefined, next, [{ id: "t1", content: "x", status: "pending", priority: "high" }]),
      ).toBeUndefined()
    }),
  )

  it.effect("requires evidence for done and blocked", () =>
    Effect.sync(() => {
      expect(GoalTool.validate({ objective: "x", status: "done" })).toBeDefined()
      expect(GoalTool.validate({ objective: "x", status: "done", evidence: "tests pass" })).toBeUndefined()
      expect(GoalTool.validate({ objective: "x", status: "blocked" })).toBeDefined()
      expect(GoalTool.validate({ objective: "x", status: "active" })).toBeUndefined()
    }),
  )
})
