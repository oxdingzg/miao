import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src"
import { OpenAI } from "../../src/providers"
import { OpenAIResponses } from "../../src/protocols/openai-responses"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"

it.effect("preserves the ultrafast service tier in native Responses requests", () =>
  Effect.gen(function* () {
    const model = OpenAI.configure({
      apiKey: "fixture-only",
      providerOptions: { openai: { serviceTier: "ultrafast" } },
    }).responses("gpt-6.1-sol")
    const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
      LLM.request({ model, prompt: "hello" }),
    )
    expect(prepared.body.service_tier).toBe("ultrafast")
  }),
)
