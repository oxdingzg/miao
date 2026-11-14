import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMEvent, Model, type LLMRequest } from "@miao/llm"
import * as OpenAIChat from "@miao/llm/protocols/openai-chat"
import { SessionSideQuestion } from "@miao/core/session/side-question"
import type { SessionMessage } from "@miao/schema/session-message"

const model = Model.make({ id: "glm-5.2", provider: "zai", route: OpenAIChat.route })

test("a side question sends no tools and pins a small output budget", async () => {
  const seen: LLMRequest[] = []
  const llm = {
    stream: (request: LLMRequest) => {
      seen.push(request)
      return Stream.fromIterable<LLMEvent>([])
    },
  }
  await Effect.runPromise(SessionSideQuestion.ask({ llm, model, messages: [], question: "还活着吗" }))
  const request = seen[0]!
  // The whole point: it answers from context and can never act.
  expect(request.tools).toEqual([])
  expect(request.toolChoice?.type).toBe("none")
  expect(request.generation?.maxTokens).toBe(2000)
})

test("the question rides after the transcript and the answer is collected", async () => {
  const seen: LLMRequest[] = []
  const llm = {
    stream: (request: LLMRequest) => {
      seen.push(request)
      return Stream.fromIterable<LLMEvent>([
        LLMEvent.textDelta({ id: "a", text: "还在跑，" }),
        LLMEvent.textDelta({ id: "a", text: "刚合并了 #1763。" }),
      ])
    },
  }
  const answer = await Effect.runPromise(
    SessionSideQuestion.ask({ llm, model, messages: [], question: "进展如何" }),
  )
  expect(answer).toBe("还在跑，刚合并了 #1763。")
  const last = seen[0]!.messages.at(-1)
  expect(last?.role).toBe("user")
})

test("a provider failure answers nothing instead of throwing", async () => {
  const llm = {
    stream: () => Stream.fromIterable<LLMEvent>([LLMEvent.providerError({ message: "boom" })]),
  }
  const answer = await Effect.runPromise(SessionSideQuestion.ask({ llm, model, messages: [], question: "hi" }))
  expect(answer).toBeUndefined()
})

test("context keeps only the recent window so a long Session stays cheap", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ type: "user", text: `m${index}` })) as SessionMessage.Message[]
  const bounded = SessionSideQuestion.context(messages)
  expect(bounded).toHaveLength(40)
  const last = bounded.at(-1)
  const first = bounded[0]
  expect(last?.type === "user" ? last.text : undefined).toBe("m99")
  expect(first?.type === "user" ? first.text : undefined).toBe("m60")
})
