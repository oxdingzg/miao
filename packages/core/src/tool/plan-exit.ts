export * as PlanExitTool from "./plan-exit"

import { ToolFailure } from "@miao/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"

const PLAN_AGENT = AgentV2.ID.make("plan")

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  switched: Schema.Literal(true),
})

const DESCRIPTION = [
  "Use this tool when you have completed the planning phase and are ready to exit plan mode.",
  "It asks the user whether to switch to the build agent and start implementing the plan.",
  "Only the user's approval switches the Session; the switch is durable for the rest of the Session.",
  "Call it after the plan is finalized and any questions are answered.",
  "Do not call it before the plan is ready, with unanswered questions, or when the user wants to keep planning.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const question = yield* QuestionV2.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    /** The root Session must still be the selected plan agent for the switch to apply. */
    const rootPlanSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (session === undefined || session.parentID !== undefined || session.agent !== PLAN_AGENT) return undefined
      return session
    })

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: () => [
            {
              type: "text",
              text: "User approved switching to the build agent. Continue by implementing the approved plan.",
            },
          ],
          execute: (_input, context) => {
            const source = {
              type: "tool" as const,
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            }
            return Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: plan_exit" })))

              // A subagent, or a root that is no longer on the plan agent, must
              // not switch itself just because its own config allows plan_exit.
              const started = yield* rootPlanSession(context.sessionID)
              if (started === undefined || context.agent !== PLAN_AGENT)
                return yield* new ToolFailure({
                  message: "Only the root plan Session can switch to the build agent.",
                })

              const answers = yield* question
                .ask({
                  sessionID: context.sessionID,
                  questions: [
                    {
                      question: "The plan is ready. Switch to the build agent and start implementing it?",
                      header: "Build Agent",
                      custom: false,
                      options: [
                        {
                          label: "Yes",
                          description: "Switch to the build agent and start implementing the plan",
                        },
                        {
                          label: "No",
                          description: "Stay with the plan agent and continue refining the plan",
                        },
                      ],
                    },
                  ],
                  tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Plan exit was not approved." })))
              if (answers[0]?.[0] !== "Yes") return yield* new ToolFailure({ message: "Plan exit was not approved." })

              // The user may switch agents manually while the question is
              // pending. Never overwrite that choice with a stale approval.
              const current = yield* rootPlanSession(context.sessionID)
              if (
                current === undefined ||
                DateTime.toEpochMillis(current.time.updated) !== DateTime.toEpochMillis(started.time.updated)
              )
                return yield* new ToolFailure({
                  message: "The Session changed while waiting for approval; the switch was not applied.",
                })

              yield* events.publish(SessionEvent.AgentSwitched, {
                sessionID: context.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                agent: "build",
              })
              return { switched: true as const }
            })
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-exit",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node, EventV2.node, SessionStore.node],
})
