export * as SendMessageTool from "./send-message"

import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool, type Context } from "./tool"

export const name = "send_message"

/** Most queued inputs a Session may accumulate from peers before delivery is refused. */
export const MAX_INBOUND_QUEUE = 16

/** Session capability injected by the runner so the tool can reach a peer Session. */
export type Send = (
  input: {
    readonly to: string
    readonly message: string
  },
  context: Context,
) => Effect.Effect<{ readonly sessionID: string }, ToolFailure>

export const Input = Schema.Struct({
  to: Schema.String.annotate({ description: "Target Session ID (ses_...)" }),
  message: Schema.String.annotate({ description: "Message to deliver to the target session" }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
})

const DESCRIPTION = [
  "Send a message to another Session in the same project so agents can coordinate.",
  "The target sees it as a queued input attributed to this session and continues on its next turn.",
  "Pass the target's Session ID in `to`.",
].join(" ")

/** Builds the canonical send_message tool around a runner-provided delivery capability. */
export const make = (send: Send): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: `Message delivered to ${output.sessionID}` }],
    execute: (input, context) => send({ to: input.to, message: input.message }, context),
  })
