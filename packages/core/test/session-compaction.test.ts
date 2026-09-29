import { expect, test } from "bun:test"
import { LLM, LLMEvent } from "@miao/llm"
import { OpenAIChat } from "@miao/llm/protocols/openai-chat"
import { Effect, Stream } from "effect"
import { SessionCompaction } from "@miao/core/session/compaction"
import { SessionSchema } from "@miao/core/session/schema"

const model = (id: string, context: number) =>
  OpenAIChat.route.with({ limits: { context, output: 4_096 } }).model({ id })

const compactionInput = (main: ReturnType<typeof model>, small: ReturnType<typeof model>) =>
  ({
    sessionID: SessionSchema.ID.make("ses_compaction_fallback"),
    entries: [{ seq: 1, message: { type: "user", id: "msg_1", text: "hello world" } }],
    model: main,
    summarizeModel: small,
    request: LLM.request({ model: main, messages: [] }),
  }) as never

const summarizeHarness = (attempts: Array<Stream.Stream<never, never>>) => {
  const requests: Array<{ readonly model: unknown }> = []
  const published: string[] = []
  let index = 0
  const compaction = SessionCompaction.make({
    events: {
      publish: (_schema: unknown, data: { text?: string }) => {
        if (typeof data?.text === "string") published.push(data.text)
        return Effect.succeed(undefined)
      },
    } as never,
    llm: {
      stream: (request: { readonly model: unknown }) => {
        requests.push(request)
        return attempts[Math.min(index++, attempts.length - 1)] as never
      },
    },
    config: [
      { type: "document", info: { compaction: { summarize_small: true, keep: { tokens: 1 } } } },
    ] as never,
  })
  return { compaction, requests, published }
}

const empty = Stream.empty as Stream.Stream<never, never>
const summary = (text: string) => Stream.make(LLMEvent.textDelta({ id: "c", text })) as Stream.Stream<never, never>

test("compaction falls back to the session model when the small model returns no summary", async () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)
  const { compaction, requests, published } = summarizeHarness([empty, summary("fallback summary")])

  const ok = await Effect.runPromise(compaction.compactAfterOverflow(compactionInput(main, small)))

  expect(ok).toBe(true)
  expect(requests.map((request) => request.model)).toEqual([small, main])
  expect(published).toEqual(["fallback summary"])
})

test("compaction does not persist an empty summary from any model", async () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)
  const { compaction, requests, published } = summarizeHarness([empty, empty])

  const ok = await Effect.runPromise(compaction.compactAfterOverflow(compactionInput(main, small)))

  expect(ok).toBe(false)
  expect(requests).toHaveLength(2)
  expect(published).toEqual([])
})

test("compaction prefers the small model when the prompt fits its context", () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main, summarizeModel: small }, 10, 4_096)).toBe(small)
})

test("compaction falls back to the session model when the prompt exceeds the small context", () => {
  const main = model("main", 100_000)
  const small = model("small", 1_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main, summarizeModel: small }, 10_000, 4_096)).toBe(main)
})

test("compaction falls back to the session model without a small model", () => {
  const main = model("main", 100_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main }, 10, 4_096)).toBe(main)
})

test("hot-prefix prompt summarizes the conversation already in context", () => {
  const prompt = SessionCompaction.buildHotPrompt()

  expect(prompt).toContain("Summarize the conversation above")
  expect(prompt).not.toContain("<conversation>")
  expect(prompt).toContain("## Work State\n### Completed")
})

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
