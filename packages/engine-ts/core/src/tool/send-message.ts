export * as SendMessageTool from "./send-message"

import { SessionDelivery } from "@miao/schema/session-delivery"
import { ToolFailure } from "@miao/llm"
import { Effect, Schema } from "effect"
import { Tool, type AnyTool, type Context } from "./tool"

export const name = "send_message"
export const MAX_INBOUND_QUEUE = 16

export const Input = Schema.Struct({
  to: Schema.String.annotate({ description: "Target Session ID (ses_...) or @slug" }),
  delivery: Schema.optional(SessionDelivery.Delivery).annotate({
    description:
      "steer (default) delivers at the next safe provider-turn boundary; queue waits until the recipient would otherwise become idle.",
  }),
  wake: Schema.optional(Schema.Literals(["if_active", "always", "never"])).annotate({
    description:
      "if_active (default) requests execution only for a peer with active execution or unfinished work; always explicitly wakes idle peers; never only leaves mail without requesting execution.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "Why coordination is needed now. Required for wake: always; cite explicit user direction, an unresolved dependency, or unfinished shared work, not just a related title.",
  }),
  message: Schema.String.annotate({ description: "Message to deliver to the target session" }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
  wake: Schema.Literals(["requested", "not_requested"]),
})

export type Send = (input: typeof Input.Type, context: Context) => Effect.Effect<typeof Output.Type, ToolFailure>

const DESCRIPTION = [
  "Send a focused coordination message to another Session in the same project.",
  "Default wake: if_active leaves mail for idle historical peers without starting them. Use read_session_context for past findings.",
  "Use wake: always with a concrete reason only when that peer's participation is needed; a matching title is insufficient.",
  "Name the resource, planned action, timing, and question. Coordinate near the conflicting action, not speculatively during unrelated preparation.",
  "Peer replies are not user approval or authoritative live resource checks; recipient permissions still apply.",
  "Recipients should address only the coordination request, not restart old tasks. Do not acknowledge acknowledgments or repeat resolved requests.",
  "Running tools are not interrupted. A wake request is advisory and does not guarantee a reply. Never wait for a message whose wake was not requested.",
].join(" ")

export const make = (send: Send): AnyTool =>
  Tool.make({
    description: DESCRIPTION,
    input: Input,
    output: Output,
    toModelOutput: ({ input, output }) => [
      {
        type: "text",
        text:
          output.wake === "not_requested"
            ? `Message left for ${output.sessionID}; execution was not requested. It may be read during later execution. Do not wait for a reply.`
            : `Message admitted for ${output.sessionID}; wake requested (advisory, not confirmed). ${input.delivery === "queue" ? "Delivery waits until the recipient would otherwise become idle." : "Delivery is at the next safe provider-turn boundary; running tools are not interrupted."} No acknowledgment is required.`,
      },
    ],
    execute: (input, context) =>
      send({ ...input, delivery: input.delivery ?? "steer", wake: input.wake ?? "if_active" }, context),
  })
