import { expect, test } from "bun:test"
import { OpenAIChat } from "@miao/llm/protocols/openai-chat"
import { SessionCompaction } from "@miao/core/session/compaction"

const model = (id: string, context: number) =>
  OpenAIChat.route.with({ limits: { context, output: 4_096 } }).model({ id })

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
