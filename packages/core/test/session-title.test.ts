import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { InvalidRequestReason, LLMError, Model, RateLimitReason, type LLMEvent, type LLMRequest } from "@miao/llm"
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


test("native and catalog creation placeholders use the same title predicate", () => {
  expect(SessionTitle.isDefault("New session")).toBe(true)
  expect(SessionTitle.isDefault("New session - 2026-10-23T00:00:00.000Z")).toBe(true)
  expect(SessionTitle.isDefault("New session planning")).toBe(false)
  expect(SessionTitle.isDefault("Fix session titles")).toBe(false)
})

test("plan exclusions and unknown models are permanent rejections; generic throttling is not", () => {
  const limit = (message: string) =>
    new LLMError({ module: "test", method: "test", reason: new RateLimitReason({ message }) })
  expect(SessionTitle.permanentRejection(limit("当前订阅套餐暂未开放GLM-5.3-Highspeed权限"))).toBe(true)
  expect(SessionTitle.permanentRejection(limit("your plan does not include this model"))).toBe(true)
  expect(SessionTitle.permanentRejection(limit("rate limit exceeded, retry later"))).toBe(false)
  expect(
    SessionTitle.permanentRejection(
      new LLMError({
        module: "test",
        method: "test",
        reason: new InvalidRequestReason({ message: "model glm-9-zzz does not exist" }),
      }),
    ),
  ).toBe(true)
})
