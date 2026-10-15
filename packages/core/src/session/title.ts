export * as SessionTitle from "./title"

import { LLM, LLMEvent, Message, SystemPart, type LLMError, type LLMRequest, type Model } from "@miao/llm"
import { Effect, Stream } from "effect"
import { SessionMessage } from "@miao/schema/session-message"

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

/** Image-only prompts need the main model's understanding, not a second vision call. */
export const prompt = (messages: ReadonlyArray<SessionMessage.Message>) => {
  const first = messages.findIndex((message) => message.type === "user")
  const user = messages[first]
  if (user?.type !== "user") return
  const text = user.text.replace(/\[Image \d+\]/gi, "").trim()
  if (!user.files?.some((file) => file.mime.startsWith("image/"))) return text || undefined
  if (
    text.length >= 8 &&
    !/^(?:请|帮我|你)?(?:看看|看下|看一下|分析一下|描述一下|识别一下)?(?:这张图片?|图片|这个|这是什么|这张图是什么|内容是什么)[\s?？!！。]*$/.test(
      text,
    ) &&
    !/^(?:please\s+)?(?:look at this|what(?:'s| is) this|describe (?:this|the) (?:image|picture))[\s?!.]*$/i.test(text)
  )
    return text
  const answer = messages
    .slice(first + 1)
    .filter((message) => message.type === "assistant")
    .map((message) =>
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
    )
    .find((value) => value.length > 0)
  if (!answer) return
  return `User request: ${text || "[Image attached]"}\nFirst assistant response:\n${answer.slice(0, 4000)}`
}

/** Asks the title model for a title of the first user prompt; undefined when it fails or answers nothing usable. */
export const generate = (input: {
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> }
  readonly model: Model
  readonly http?: LLMRequest["http"]
  readonly system?: string
  readonly prompt: string
  readonly providerOptions?: LLMRequest["providerOptions"]
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
          providerOptions: input.providerOptions,
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
