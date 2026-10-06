export * as PlanApprovalTool from "./plan-approval"

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

export type Direction = "plan_exit" | "plan_enter"

type Approval = {
  readonly question: string
  readonly header: string
  readonly yes: string
  readonly no: string
  readonly denied: string
  readonly changed: string
}

type Model = {
  /** Permission action a Session must allow to request the switch. */
  readonly action: Direction
  /** Agent the requesting Session must currently be on. */
  readonly from: AgentV2.ID
  /** Agent the approval switches the Session to. */
  readonly to: AgentV2.ID
  readonly description: string
  readonly approved: string
  readonly wrongRoot: string
  /** When set, the switch waits for the user's Yes; otherwise it applies immediately. */
  readonly approval?: Approval
}

export const EXIT: Model = {
  action: "plan_exit",
  from: AgentV2.ID.make("plan"),
  to: AgentV2.ID.make("build"),
  description: [
    "Use this tool when you have completed the planning phase and are ready to start implementing.",
    "It switches the Session to the build agent immediately, then continue by carrying out the plan.",
    "Call it after the plan is finalized and any questions are answered.",
    "Do not call it before the plan is ready, with unanswered questions, or when the user wants to keep planning.",
  ].join("\n"),
  approved: "Switched to the build agent. Continue by implementing the plan.",
  wrongRoot: "Only the root plan Session can switch to the build agent.",
}

export const ENTER: Model = {
  action: "plan_enter",
  from: AgentV2.ID.make("build"),
  to: AgentV2.ID.make("plan"),
  description: [
    "Use this tool when the user asks to plan, research, or design before any code is changed.",
    "It asks the user whether to switch to the plan agent, which cannot edit files.",
    "Only the user's approval switches the Session; the switch is durable for the rest of the Session.",
    "Call it when the request needs design or investigation, not for a task that is already ready to implement.",
  ].join("\n"),
  approved: "User approved switching to the plan agent. Plan the approach before making changes.",
  wrongRoot: "Only the root build Session can switch to the plan agent.",
  approval: {
    question: "Switch to the plan agent and start planning before making any changes?",
    header: "Plan Agent",
    yes: "Switch to the plan agent and design the approach first",
    no: "Stay with the build agent and continue implementing",
    denied: "Plan entry was not approved.",
    changed: "The Session changed while waiting for approval; the switch was not applied.",
  },
}

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  switched: Schema.Literal(true),
})

const layerFor = (model: Model) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const permission = yield* PermissionV2.Service
      const question = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      // The root Session must still be on the requesting agent for the switch to apply.
      const rootSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        const session = yield* store.get(sessionID)
        if (session === undefined || session.parentID !== undefined || session.agent !== model.from) return undefined
        return session
      })

      yield* tools
        .register({
          [model.action]: Tool.withPermission(
            Tool.make({
            description: model.description,
            input: Input,
            output: Output,
            toModelOutput: () => [{ type: "text", text: model.approved }],
            execute: (_input, context) => {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              return Effect.gen(function* () {
                yield* permission
                  .assert({
                    action: model.action,
                    resources: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                    // The plan-mode switches are control actions: a bare `*`
                    // allow rule must not decide (or re-enable) them.
                    explicit: true,
                  })
                  .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${model.action}` })))

                // A subagent, or a root no longer on the requesting agent, must
                // not switch itself just because its own config allows the action.
                const started = yield* rootSession(context.sessionID)
                if (started === undefined || context.agent !== model.from)
                  return yield* new ToolFailure({ message: model.wrongRoot })

                // An interactive switch waits for the user's Yes; an automatic
                // switch (for example plan exit) applies immediately.
                const approval = model.approval
                if (approval !== undefined) {
                  const answers = yield* question
                    .ask({
                      sessionID: context.sessionID,
                      questions: [
                        {
                          question: approval.question,
                          header: approval.header,
                          custom: false,
                          options: [
                            { label: "Yes", description: approval.yes },
                            { label: "No", description: approval.no },
                          ],
                        },
                      ],
                      tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(Effect.mapError(() => new ToolFailure({ message: approval.denied })))
                  if (answers[0]?.[0] !== "Yes") return yield* new ToolFailure({ message: approval.denied })

                  // The user may switch agents manually while the question is
                  // pending. Never overwrite that choice with a stale approval.
                  const current = yield* rootSession(context.sessionID)
                  if (
                    current === undefined ||
                    DateTime.toEpochMillis(current.time.updated) !== DateTime.toEpochMillis(started.time.updated)
                  )
                    return yield* new ToolFailure({ message: approval.changed })
                }

                yield* events.publish(SessionEvent.AgentSwitched, {
                  sessionID: context.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  agent: model.to,
                })
                return { switched: true as const }
              })
            },
            }),
            model.action,
            { explicit: true },
          ),
        })
        .pipe(Effect.orDie)
    }),
  )

export const exitLayer = layerFor(EXIT)
export const enterLayer = layerFor(ENTER)

export const node = makeLocationNode({
  name: "tool/plan-approval",
  layer: Layer.mergeAll(exitLayer, enterLayer),
  deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node, EventV2.node, SessionStore.node],
})
