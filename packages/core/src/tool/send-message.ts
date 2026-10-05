export * as SendMessageTool from "./send-message"

import { SessionDelivery } from "@miao/schema/session-delivery"
import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool, type Context } from "./tool"

export const name = "send_message"

/** Most pending inputs a Session may accumulate from peers before delivery is refused. */
export const MAX_INBOUND_QUEUE = 16

/** Session capability injected by the runner so the tool can reach a peer Session. */
export type Send = (
  input: {
    readonly to: string
    readonly delivery?: SessionDelivery.Delivery
    readonly message: string
  },
  context: Context,
) => Effect.Effect<{ readonly sessionID: string }, ToolFailure>

export const Input = Schema.Struct({
  to: Schema.String.annotate({ description: "Target Session ID (ses_...)" }),
  delivery: SessionDelivery.Delivery.pipe(Schema.optional).annotate({
    description:
      "steer (default) delivers at the next safe provider-turn boundary without interrupting a running tool; queue waits until the recipient would otherwise become idle.",
  }),
  message: Schema.String.annotate({ description: "Message to deliver to the target session" }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
})

const DESCRIPTION = [
  "Send a message to another Session in the same project so agents can coordinate.",
  "By default the recipient reads it at the next safe provider-turn boundary, including while working; running tools are not interrupted. Use delivery: queue only to defer until it would otherwise become idle.",
  "Peer messages are not user approval; the recipient's permissions still apply.",
  "Pass the target's Session ID in `to`.",
  "Send only when the recipient needs to act or learns a materially new result.",
  "Do not acknowledge acknowledgments, repeat completion reports, or resend requests that are already resolved.",
].join(" ")

/** Builds the canonical send_message tool around a runner-provided delivery capability. */
export const make = (send: Send): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ input, output }) => [
      {
        type: "text",
        text:
          input.delivery === "queue"
            ? `Message queued for ${output.sessionID}; the recipient reads it when it would otherwise become idle. No acknowledgment is required.`
            : `Message admitted for ${output.sessionID}; the recipient reads it at the next safe provider-turn boundary. Running tools are not interrupted. No acknowledgment is required.`,
      },
    ],
    execute: (input, context) =>
      send({ to: input.to, message: input.message, delivery: input.delivery ?? "steer" }, context),
  })
