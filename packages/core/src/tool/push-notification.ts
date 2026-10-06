export * as PushNotificationTool from "./push-notification"

import { ToolFailure } from "@miao/llm"
import { DateTime, Effect, Schema } from "effect"
import type { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import type { SessionSchema } from "../session/schema"
import { Tool, type AnyTool } from "./tool"

export const name = "push_notification"

export const Input = Schema.Struct({
  message: Schema.String.annotate({
    description: "One line the human can act on. Lead with what happened, not with the fact that something did.",
  }),
  title: Schema.String.pipe(Schema.optional).annotate({
    description: "Short subject line. Defaults to the Session title.",
  }),
})

export const Output = Schema.Struct({
  message: Schema.String,
})

const DESCRIPTION = [
  "Pull the human's attention back to this Session.",
  "Use it when something finishes or breaks while they have walked away, and only when they would want to",
  "know now: a long build that finally passed, a deploy that failed, a decision you cannot make alone.",
  "A notification interrupts whatever they are doing, so do not send one for routine progress, for",
  "something they are already watching, or to repeat a question that is still pending.",
  "It reaches whoever is listening — the terminal, or their phone — and there may be nobody, so never",
  "treat the notification as the only place an important result is recorded.",
].join(" ")

/**
 * Publishes the notification as a transient Session event. Nothing is stored: the
 * terminal attention host and the remote-control push fan-out each subscribe and
 * decide for themselves whether the human should be interrupted.
 */
export const publish = (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  input: { readonly title?: string; readonly message: string },
) =>
  Effect.gen(function* () {
    yield* events.publish(SessionEvent.Notified, {
      sessionID,
      timestamp: yield* DateTime.now,
      ...(input.title === undefined ? {} : { title: input.title }),
      message: input.message,
    })
  })

/** Session capability injected by the runner: the notification is published as a Session event. */
export type Notify = (input: { readonly title?: string; readonly message: string }) => Effect.Effect<void, ToolFailure>

export const make = (notify: Notify): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text" as const, text: `Notification raised: ${output.message}` }],
    execute: (input) =>
      notify({ title: input.title, message: input.message }).pipe(Effect.as({ message: input.message })),
  })
