import { applyCachePolicy } from "@miao/llm/cache-policy"
import { LLM, Message, ToolDefinition } from "@miao/llm"
import { Auth } from "@miao/llm/route"
import * as AnthropicMessages from "@miao/llm/protocols/anthropic-messages"
import { SessionPrune } from "../src/session/prune"
import type { Suite } from "./lib/harness"

const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "fixture") })
  .model({ id: "claude-sonnet-4-5" })

/**
 * Per-step request preparation for a large conversation. Every provider turn
 * walks the whole history before it can be sent: pruning clears tool output the
 * agent no longer needs and the cache policy walks the same parts to place
 * breakpoints. Both run once per step, so their cost multiplies by the steps a
 * turn takes, and a super-linear regression here is invisible to a unit test and
 * obvious on a long session.
 */
const conversation = (pairs: number) => {
  const messages: Message[] = [Message.user("Investigate the failing build and report back.")]
  for (let index = 0; index < pairs; index++) {
    messages.push(
      Message.assistant(`Step ${index}: reading the failing test and checking the module it imports.`),
      Message.tool({
        id: `call_${index}`,
        name: index % 3 === 0 ? "bash" : "read",
        result: `${"line of output\n".repeat(40)}step ${index}`,
      }),
    )
  }
  return messages
}

const request = (pairs: number) =>
  LLM.request({
    model,
    system: [{ type: "text" as const, text: "You are a coding agent." }],
    tools: Array.from({ length: 40 }, (_, index) =>
      ToolDefinition.make({
        name: `tool_${index}`,
        description: `Tool number ${index}`,
        inputSchema: { type: "object", properties: { input: { type: "string" } } },
      }),
    ),
    messages: conversation(pairs),
    cache: "auto" as const,
  })

const SMALL = 100
const LARGE = 400

export const suite: Suite = {
  name: "request-preparation",
  measurements: [
    {
      name: `prune/${SMALL * 2}`,
      // Local medians: 6ms, 9ms, 30ms. References sit roughly four times above
      // them so the gate catches a real regression without failing on noise;
      // tighten them from the reported CI numbers.
      referenceMs: 25,
      body: () => {
        SessionPrune.toolResults(conversation(SMALL))
      },
    },
    {
      name: `prune/${LARGE * 2}`,
      referenceMs: 40,
      scaling: { baseline: `prune/${SMALL * 2}`, maximum: 8 },
      body: () => {
        SessionPrune.toolResults(conversation(LARGE))
      },
    },
    {
      name: `cache-policy/${LARGE * 2}`,
      referenceMs: 100,
      body: () => {
        applyCachePolicy(request(LARGE))
      },
    },
  ],
}
