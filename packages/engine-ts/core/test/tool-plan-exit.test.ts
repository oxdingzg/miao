import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { EventTable } from "@miao/core/event/sql"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { ProjectV2 } from "@miao/core/project"
import { QuestionV2 } from "@miao/core/question"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionMessage } from "@miao/core/session/message"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { PlanExitTool } from "@miao/core/tool/plan-exit"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const planAgent = AgentV2.ID.make("plan")

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const assertions: PermissionV2.AssertInput[] = []
let deny = false
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

let captured: QuestionV2.AskInput | undefined
let outcome: "yes" | "no" | "dismiss" = "yes"
let onAsk: (() => Effect.Effect<void>) | undefined
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
        Effect.andThen(Effect.suspend(() => onAsk?.() ?? Effect.void)),
        Effect.andThen(
          outcome === "dismiss"
            ? Effect.fail(new QuestionV2.RejectedError())
            : Effect.succeed([[outcome === "yes" ? "Yes" : "No"]]),
        ),
      ),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PlanExitTool.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [PermissionV2.node, permission],
      [QuestionV2.node, question],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const reset = () => {
  assertions.length = 0
  deny = false
  captured = undefined
  outcome = "yes"
  onAsk = undefined
}

const call = (sessionID: SessionV2.ID, input: Record<string, unknown> = {}) => ({
  sessionID,
  agent: planAgent,
  assistantMessageID: SessionMessage.ID.make("msg_plan_exit"),
  call: { type: "tool-call" as const, id: "call-plan-exit", name: "plan_exit", input },
})

describe("PlanExitTool", () => {
  it.effect("switches the same root plan Session to build automatically", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("plan_exit")
      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({
        type: "text",
        value: "Switched to the build agent. Continue by implementing the plan.",
      })
      // The switch is durable: the event is recorded and projects to the row the
      // next provider turn reads its agent from.
      const history = yield* session.history({ sessionID: created.id, limit: 10 })
      expect(history.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.next.agent.switched",
            data: expect.objectContaining({ agent: "build" }),
          }),
        ]),
      )
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const recorded = yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      yield* events.remove(created.id)
      yield* database.db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })

      expect(assertions.map((input) => input.action)).toEqual(["plan_exit"])
      // Plan exit applies without asking the user.
      expect(captured).toBeUndefined()
    }),
  )

  it.effect("hides plan_exit and refuses execution when the action is denied", () =>
    Effect.gen(function* () {
      reset()
      deny = true
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      expect(yield* toolDefinitions(registry, [{ action: "plan_exit", resource: "*", effect: "deny" }])).toEqual([])
      const settled = yield* executeTool(registry, call(created.id))
      expect(settled).toEqual({ type: "error", value: "Permission denied: plan_exit" })
      expect(captured).toBeUndefined()
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )

  it.effect("refuses to switch a subagent session even when its permission allows plan_exit", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const parent = yield* session.create({ location, agent: planAgent })
      const child = yield* session.create({ location, agent: planAgent, parentID: parent.id })

      const settled = yield* settleTool(registry, call(child.id))

      expect(settled.result).toEqual({
        type: "error",
        value: "Only the root plan Session can switch to the build agent.",
      })
      expect(captured).toBeUndefined()
      expect(yield* session.get(child.id)).toMatchObject({ agent: "plan" })
    }),
  )

  it.effect("ignores unexpected input and switches automatically", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      // There is no approval field; extra input is stripped and the switch
      // still applies without asking the user.
      const settled = yield* settleTool(registry, call(created.id, { approved: true, agent: "build" }))

      expect(captured).toBeUndefined()
      expect(settled.result).toEqual({
        type: "text",
        value: "Switched to the build agent. Continue by implementing the plan.",
      })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
    }),
  )
})
