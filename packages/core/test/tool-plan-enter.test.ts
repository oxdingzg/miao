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
import { PlanApprovalTool } from "@miao/core/tool/plan-approval"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const buildAgent = AgentV2.ID.make("build")
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
      PlanApprovalTool.node,
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

const call = (sessionID: SessionV2.ID, tool = "plan_enter", agent = buildAgent, input: Record<string, unknown> = {}) => ({
  sessionID,
  agent,
  assistantMessageID: SessionMessage.ID.make("msg_plan_enter"),
  call: { type: "tool-call" as const, id: `call-${tool}`, name: tool, input },
})

describe("PlanEnterTool", () => {
  it.effect("both plan directions register as model-facing tools", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
      expect(names).toContain("plan_enter")
      expect(names).toContain("plan_exit")
    }),
  )

  it.effect("switches the same root build Session to plan only after the user approves", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: buildAgent })

      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({
        type: "text",
        value: "User approved switching to the plan agent. Plan the approach before making changes.",
      })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(assertions.map((input) => input.action)).toEqual(["plan_enter"])
      expect(assertions[0]?.explicit).toBe(true)
      expect(captured?.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"])
      expect(captured?.questions[0]?.header).toBe("Plan Agent")
    }),
  )

  it.effect("keeps the build agent when the user declines or dismisses", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      for (const answer of ["no", "dismiss"] as const) {
        reset()
        outcome = answer
        const created = yield* session.create({ location, agent: buildAgent })
        const settled = yield* settleTool(registry, call(created.id))
        expect(settled.result).toEqual({ type: "error", value: "Plan entry was not approved." })
        expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
      }
    }),
  )

  it.effect("hides plan_enter when denied and refuses execution", () =>
    Effect.gen(function* () {
      reset()
      deny = true
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: buildAgent })

      const visible = (yield* toolDefinitions(registry, [{ action: "plan_enter", resource: "*", effect: "deny" }])).map(
        (tool) => tool.name,
      )
      expect(visible).not.toContain("plan_enter")
      expect(visible).toContain("plan_exit")
      const settled = yield* executeTool(registry, call(created.id))
      expect(settled).toEqual({ type: "error", value: "Permission denied: plan_enter" })
      expect(captured).toBeUndefined()
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
    }),
  )

  it.effect("does not let a catch-all allow rule expose a plan switch", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      // The build agent defaults carry a specific deny for both switches; a
      // later catch-all `*: allow` (for example a user `"*": "allow"`) must not
      // re-enable them, because their actions are explicit.
      const visible = (
        yield* toolDefinitions(registry, [
          { action: "*", resource: "*", effect: "allow" },
          { action: "plan_enter", resource: "*", effect: "deny" },
          { action: "plan_exit", resource: "*", effect: "deny" },
        ])
      ).map((tool) => tool.name)
      expect(visible).not.toContain("plan_enter")
      expect(visible).not.toContain("plan_exit")
    }),
  )

  it.effect("refuses to switch a subagent even when its permission allows plan_enter", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const parent = yield* session.create({ location, agent: buildAgent })
      const child = yield* session.create({ location, agent: buildAgent, parentID: parent.id })

      const settled = yield* settleTool(registry, call(child.id))

      expect(settled.result).toEqual({
        type: "error",
        value: "Only the root build Session can switch to the plan agent.",
      })
      expect(captured).toBeUndefined()
      expect(yield* session.get(child.id)).toMatchObject({ agent: "build" })
    }),
  )

  it.effect("does not overwrite a manual switch made while the question waits", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: buildAgent })
      onAsk = () => session.switchAgent({ sessionID: created.id, agent: AgentV2.ID.make("manual") }).pipe(Effect.orDie)

      const settled = yield* settleTool(registry, call(created.id))

      expect(settled.result).toEqual({
        type: "error",
        value: "The Session changed while waiting for approval; the switch was not applied.",
      })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "manual" })
    }),
  )

  it.effect("ignores unexpected input instead of letting it skip the question", () =>
    Effect.gen(function* () {
      reset()
      outcome = "no"
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: buildAgent })

      const settled = yield* settleTool(registry, call(created.id, "plan_enter", buildAgent, { approved: true }))

      expect(captured).toBeDefined()
      expect(settled.result).toEqual({ type: "error", value: "Plan entry was not approved." })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "build" })
    }),
  )

  it.effect("refuses plan_enter from a Session that is not on the build agent", () =>
    Effect.gen(function* () {
      reset()
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const created = yield* session.create({ location, agent: planAgent })

      const settled = yield* settleTool(registry, call(created.id, "plan_enter", planAgent))

      expect(settled.result).toEqual({
        type: "error",
        value: "Only the root build Session can switch to the plan agent.",
      })
      expect(captured).toBeUndefined()
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )
})
