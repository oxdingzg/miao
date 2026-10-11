import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Model, type LLMEvent, type LLMRequest } from "@miao/llm"
import * as OpenAIChat from "@miao/llm/protocols/openai-chat"
import { SessionTitle } from "@miao/core/session/title"

test("an auxiliary title call carries its provider options into the request", async () => {
  const seen: LLMRequest[] = []
  const llm = {
    stream: (request: LLMRequest) => {
      seen.push(request)
      return Stream.fromIterable<LLMEvent>([])
    },
  }
  const title = await Effect.runPromise(
    SessionTitle.generate({
      llm,
      model: Model.make({ id: "glm-5.2", provider: "zai", route: OpenAIChat.route }),
      prompt: "hello",
      providerOptions: { "@ai-sdk/openai-compatible": { reasoningEffort: "low" } },
    }),
  )
  expect(title).toBeUndefined()
  expect(seen[0]?.providerOptions).toEqual({ "@ai-sdk/openai-compatible": { reasoningEffort: "low" } })
})
