export * as SessionSideQuestion from "./side-question"

import { LLM, LLMEvent, Message, SystemPart, type LLMError, type LLMRequest, type Model } from "@miao/llm"
import { Effect, Stream } from "effect"
import { SessionMessage } from "@miao/schema/session-message"
import { toLLMMessages } from "./to-llm-message"

// A side question answers from what the conversation already holds; it never
// acts and never enters the transcript. The recent-window bound keeps it cheap
// on a long Session: it re-reads only the tail the question is really about,
// not a whole history the main turn already pays to carry.
const CONTEXT_MESSAGES = 40
const MAX_OUTPUT = 2_000

const SYSTEM = `Answer the question from the conversation so far, briefly and directly. You have no tools: answer only from what is already in context, and say plainly when the context does not contain the answer. Do not propose work, call tools, or recap the whole conversation.`

/** Keeps the newest slice of history so a side question stays cheap on a long Session. */
export const context = (messages: readonly SessionMessage.Message[]) => messages.slice(-CONTEXT_MESSAGES)

/** The empty answer a failed or silent side question returns; it never throws at the caller. */
export const NONE = undefined

/**
 * Asks one side question against the transcript with no tools, returning the
 * answer text without persisting anything. It mirrors `SessionTitle.generate`:
 * a single streamed call that collects text and reports a provider failure as
 * no answer rather than an error, so a question during a busy turn never
 * disturbs the main run.
 */
export const ask = (input: {
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> }
  readonly model: Model
  readonly http?: LLMRequest["http"]
  readonly messages: readonly SessionMessage.Message[]
  readonly question: string
  /** The target model's declared input modalities; images are dropped to a placeholder when absent. */
  readonly capabilities?: readonly string[]
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
          system: [SystemPart.make(SYSTEM)],
          messages: [
            ...toLLMMessages(context(input.messages), input.model, input.capabilities),
            Message.user(input.question),
          ],
          tools: [],
          toolChoice: "none",
          generation: { maxTokens: MAX_OUTPUT },
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
    if (failed) return NONE
    return chunks.join("").trim() || NONE
  })
