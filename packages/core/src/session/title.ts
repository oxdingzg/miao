export * as SessionTitle from "./title"

import { LLM, LLMEvent, Message, SystemPart, type LLMError, type LLMRequest, type Model } from "@miao/llm"
import { Effect, Stream } from "effect"

const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_LENGTH = 100

/** True for the placeholder title Session creation assigns; anything else was set on purpose. */
export const isDefault = (title: string) => DEFAULT_TITLE.test(title)

/** Keeps the first non-empty line of a title-model reply, without reasoning blocks, capped like V1. */
export const clean = (text: string) => {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 3)}...` : line
}

/** Asks the title model for a title of the first user prompt; undefined when it fails or answers nothing usable. */
export const generate = (input: {
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> }
  readonly model: Model
  readonly http?: LLMRequest["http"]
  readonly system?: string
  readonly prompt: string
}) =>
  Effect.gen(function* () {
    const chunks: string[] = []
    let failed = false
    yield* input.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.http,
          system: input.system ? [SystemPart.make(input.system)] : [],
          messages: [Message.user("Generate a title for this conversation:\n"), Message.user(input.prompt)],
          tools: [],
        }),
      )
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (LLMEvent.is.providerError(event)) failed = true
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          }),
        ),
      )
    return failed ? undefined : clean(chunks.join(""))
  })
