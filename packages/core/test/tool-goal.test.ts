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

  it.effect("renders status, budget, and evidence", () =>
    Effect.sync(() => {
      const text = GoalTool.render({ objective: "Fix it", status: "blocked", evidence: "waiting on upstream" })
      expect(text).toContain('<goal status="blocked">')
      expect(text).toContain("Fix it")
      expect(text).toContain("evidence: waiting on upstream")
    }),
  )
})
