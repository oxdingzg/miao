import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@miao/llm"
import { SessionOutputGuard } from "@miao/core/session/runner/output-guard"

const loop = "Emit.\n\nedit.\n\n".repeat(80)

describe("SessionOutputGuard", () => {
  test("detects single-line and alternating short prose loops", () => {
    expect(SessionOutputGuard.detect(loop)).toBe(true)
    expect(SessionOutputGuard.detect("我发出工具调用。\n好。\n".repeat(80))).toBe(true)
    expect(SessionOutputGuard.detect("Let me check the entity model.\n".repeat(80))).toBe(true)
  })

  test("is invariant to token, CRLF and Unicode chunk boundaries", () => {
    const text = "好。\r\n\r\n我输出。\r\n".repeat(80)
    const observe = SessionOutputGuard.make()
    const detected = [...text].some((text) => observe(LLMEvent.reasoningDelta({ id: "r", text })) === "reasoning")
    expect(detected).toBe(true)
  })

  test("allows ordinary progress, code, tables, lists and short repetition", () => {
    const examples = [
      "Emit.\nedit.\n".repeat(8),
      Array.from({ length: 200 }, (_, i) => `Step ${i}: inspect the next result.`).join("\n"),
      `\`\`\`text\n${loop}\`\`\`\n`,
      `~~~text\n${loop}~~~\n`,
      "return value;\n".repeat(100),
      "{\n}\n".repeat(100),
      "| Yes | No |\n".repeat(100),
      "- item\n".repeat(100),
      "1. item\n".repeat(100),
      "x".repeat(1_000_000),
    ]
    examples.forEach((text) => expect(SessionOutputGuard.detect(text)).toBe(false))
  })

  test("isolates parts, channels, turns and observer instances", () => {
    const first = SessionOutputGuard.make()
    const second = SessionOutputGuard.make()
    const half = "Emit.\n".repeat(40)
    expect(first(LLMEvent.textDelta({ id: "a", text: half }))).toBeUndefined()
    expect(first(LLMEvent.textDelta({ id: "b", text: half }))).toBeUndefined()
    expect(first(LLMEvent.reasoningDelta({ id: "a", text: half }))).toBeUndefined()
    expect(second(LLMEvent.textDelta({ id: "a", text: half }))).toBeUndefined()
    first(LLMEvent.textEnd({ id: "a" }))
    expect(first(LLMEvent.textDelta({ id: "a", text: half }))).toBeUndefined()
    first(LLMEvent.stepStart({ index: 1 }))
    expect(first(LLMEvent.reasoningDelta({ id: "a", text: half }))).toBeUndefined()
  })

  test("does not inspect tool input or carry prose counts through structured output", () => {
    const observe = SessionOutputGuard.make()
    expect(observe(LLMEvent.toolInputDelta({ id: "call", name: "write", text: loop }))).toBeUndefined()
    expect(observe(LLMEvent.textDelta({ id: "a", text: "Emit.\n".repeat(40) }))).toBeUndefined()
    expect(observe(LLMEvent.textDelta({ id: "a", text: '{"value": 1}\n' }))).toBeUndefined()
    expect(observe(LLMEvent.textDelta({ id: "a", text: "Emit.\n".repeat(40) }))).toBeUndefined()
  })

  test("fails non-retryably and closes upstream before a later tool call", async () => {
    const seen: LLMEvent[] = []
    let closed = false
    const source = Stream.fromIterable([
      LLMEvent.textStart({ id: "a" }),
      ...Array.from({ length: 80 }, () => LLMEvent.textDelta({ id: "a", text: "Emit.\nedit.\n" })),
      LLMEvent.toolCall({ id: "late", name: "write", input: {} }),
    ]).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          closed = true
        }),
      ),
    )
    const result = await Effect.runPromise(
      source.pipe(
        SessionOutputGuard.wrap,
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event)
          }),
        ),
        Effect.flip,
      ),
    )
    expect(result.reason._tag).toBe("InvalidProviderOutput")
    expect(result.retryable).toBe(false)
    expect(result.message).toContain("Stopped repetitive text output")
    expect(seen.some((event) => event.type === "tool-call")).toBe(false)
    expect(seen.length).toBeLessThan(80)
    expect(closed).toBe(true)
  })

  test("fresh stream subscriptions do not share detection state", async () => {
    const events = [LLMEvent.textDelta({ id: "a", text: "Emit.\n".repeat(40) })]
    const guarded = SessionOutputGuard.wrap(Stream.fromIterable(events))
    expect(await Effect.runPromise(guarded.pipe(Stream.runCollect))).toEqual(events)
    expect(await Effect.runPromise(guarded.pipe(Stream.runCollect))).toEqual(events)
  })
})
