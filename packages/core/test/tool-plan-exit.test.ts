import { describe, expect } from "bun:test"
import { AgentV2 } from "@miao/core/agent"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
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
import { ToolRegistry } from "@miao/core/tool/registry"
import { PlanExitTool } from "@miao/core/tool/plan-exit"
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
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
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
}

const call = (sessionID: SessionV2.ID) => ({
  sessionID,
  agent: planAgent,
  assistantMessageID: SessionMessage.ID.make("msg_plan_exit"),
  call: { type: "tool-call" as const, id: "call-plan-exit", name: "plan_exit", input: {} },
})

describe("PlanExitTool", () => {
  it.effect("switches the same Session to build only after the user approves", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("plan_exit")
      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({
        type: "text",
        value: "User approved switching to the build agent. Continue by implementing the approved plan.",
      })
      // The durable event projects to the Session row, so the next turn runs build.
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
      expect(assertions.map((input) => input.action)).toEqual(["plan_exit"])
      expect(captured?.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"])
    }),
  )

  it.effect("keeps the plan agent and does not publish a switch when the user declines", () =>
    Effect.gen(function* () {
      reset()
      outcome = "no"
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({ type: "error", value: "Plan exit was not approved." })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )

  it.effect("keeps the plan agent when the user dismisses the question", () =>
    Effect.gen(function* () {
      reset()
      outcome = "dismiss"
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({ type: "error", value: "Plan exit was not approved." })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
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

  it.effect("exposes no input that could grant approval on the user's behalf", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "plan_exit")
      const schema = definition?.inputSchema as { readonly properties?: Record<string, unknown> } | undefined
      // A peer or subagent cannot pre-approve: approval only comes from the
      // user's question reply, never from tool input.
      expect(Object.keys(schema?.properties ?? {})).toEqual([])
    }),
  )
})
