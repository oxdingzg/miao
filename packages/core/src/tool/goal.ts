export * as GoalTool from "./goal"

import { SessionGoal } from "../session/goal"
import { ToolFailure } from "@miao/llm"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { Tool, type AnyTool } from "./tool"

export const name = "goal"

export const Status = SessionGoal.Status
export type Status = SessionGoal.Status
export const Info = SessionGoal.Info
export type Info = SessionGoal.Info

export const Input = Info
export const Output = Info

const DESCRIPTION = [
  "Record or update the session's goal: the outcome to achieve, its status (active, paused, blocked, or done), any evidence, and an optional budget.",
  "Use done only with evidence that proves completion; use blocked with the blocker described. The goal is durable and shown to the model on later turns.",
].join(" ")

/** The durable text a `session.next.synthetic` event carries for the goal. */
export const render = (goal: Info): string =>
  [
    `<goal status="${goal.status}">`,
    goal.objective,
    ...(goal.autonomous === undefined ? [] : [`autonomous: ${goal.autonomous}`]),
    ...(goal.budget === undefined ? [] : [`budget: ${goal.budget}`]),
    ...(goal.evidence === undefined ? [] : [`evidence: ${goal.evidence}`]),
    "</goal>",
  ].join("\n")

/** Publishes a durable `session.next.synthetic` message carrying the goal. */
export const record = (events: EventV2.Interface, sessionID: SessionSchema.ID, goal: Info) =>
  Effect.gen(function* () {
    yield* events.publish(SessionEvent.Synthetic, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: yield* DateTime.now,
      text: render(goal),
      metadata: { goal },
    })
  })

/** A goal may be `done` or `blocked` only with evidence; returns the reason otherwise. */
export const validate = (goal: Info): string | undefined => {
  const evidence = goal.evidence?.trim()
  if (goal.status === "done" && !evidence) return "A goal may be marked done only with evidence that proves completion."
  if (goal.status === "blocked" && !evidence) return "A blocked goal must name the blocker as evidence."
  return undefined
}

/** Builds the canonical goal tool around a runner-provided durable recorder. */
export const make = (record: (goal: Info) => Effect.Effect<void, ToolFailure>): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: render(output) }],
    execute: (input) =>
      Effect.gen(function* () {
        const invalid = validate(input)
        if (invalid !== undefined) return yield* new ToolFailure({ message: invalid })
        yield* record(input)
        return input
      }),
  })
