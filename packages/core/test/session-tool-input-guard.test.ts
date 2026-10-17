import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LLMError, LLMEvent } from "@miao/llm"
import { SessionToolInputGuard } from "@miao/core/session/runner/tool-input-guard"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const started = LLMEvent.toolInputStart({ id: "call", name: "edit" })

describe("SessionToolInputGuard", () => {
  it.live("counts UTF-8 bytes across chunks and cancels upstream before dispatch", () =>
    Effect.gen(function* () {
      let closed = false
      const source = Stream.fromIterable([
        started,
        LLMEvent.toolInputDelta({ id: "call", name: "edit", text: "猫" }),
        LLMEvent.toolInputDelta({ id: "call", name: "edit", text: "猫" }),
        LLMEvent.toolCall({ id: "call", name: "edit", input: {} }),
      ]).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            closed = true
          }),
        ),
      )
      const seen: LLMEvent[] = []
      const error = yield* SessionToolInputGuard.wrap(source, { maxBytes: 5 }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event)
          }),
        ),
        Effect.flip,
      )
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason.message).toContain("6 bytes exceeds 5")
      expect(error.retryable).toBe(false)
      expect(seen.map((event) => event.type)).toEqual(["tool-input-start", "tool-input-delta"])
      expect(closed).toBe(true)
      expect(JSON.stringify(error)).not.toContain("猫")
    }),
  )

  it.live("checks final-only arguments before dispatch without replaying provider-managed calls", () =>
    Effect.gen(function* () {
      const local = LLMEvent.toolCall({ id: "call", name: "edit", input: { text: "large payload" } })
      const error = yield* SessionToolInputGuard.wrap(Stream.make(local), { maxBytes: 5 }).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(error.reason.message).toContain("bytes exceeds 5")
      const managed = LLMEvent.toolCall({
        id: "call",
        name: "hosted",
        input: { text: "large payload" },
        providerExecuted: true,
      })
      expect(yield* SessionToolInputGuard.wrap(Stream.make(managed), { maxBytes: 5 }).pipe(Stream.runCollect)).toEqual([
        managed,
      ])
    }),
  )

  it.live("times out an unfinished call even when no new deltas arrive", () =>
    Effect.gen(function* () {
      const stream = Stream.concat(Stream.make(started), Stream.never)
      const error = yield* SessionToolInputGuard.wrap(stream, { timeoutMs: 20 }).pipe(Stream.runDrain, Effect.flip)
      expect(error.reason.message).toContain("idle limit 20ms")
      expect(error.retryable).toBe(false)
      // The runner needs to tell an idle trip from the byte budget it must not replay.
      const reason = error.reason
      expect(reason._tag).toBe("InvalidProviderOutput")
      if (reason._tag === "InvalidProviderOutput")
        expect(reason.toolInput).toMatchObject({ callID: "call", budget: "idle" })
    }),
  )

  it.live("stops timing completed arguments while tool execution or text continues", () =>
    Effect.gen(function* () {
      const events = [started, LLMEvent.toolInputEnd({ id: "call", name: "edit" })]
      const stream = Stream.concat(
        Stream.fromIterable(events),
        Stream.fromEffect(Effect.sleep(40).pipe(Effect.as(LLMEvent.textDelta({ id: "answer", text: "completed" })))),
      )
      expect(yield* SessionToolInputGuard.wrap(stream, { timeoutMs: 10 }).pipe(Stream.runCollect)).toHaveLength(3)
    }),
  )

  it.live("allows intentional large repeated inputs under an explicit larger budget", () =>
    Effect.gen(function* () {
      const text = "repeated source content".repeat(1000)
      const events = [
        started,
        LLMEvent.toolInputDelta({ id: "call", name: "edit", text }),
        LLMEvent.toolInputEnd({ id: "call", name: "edit" }),
      ]
      expect(
        yield* SessionToolInputGuard.wrap(Stream.fromIterable(events), { maxBytes: 100_000 }).pipe(Stream.runCollect),
      ).toEqual(events)
    }),
  )

  it.live("does not apply the tool argument deadline to ordinary answers", () =>
    Effect.gen(function* () {
      const stream = Stream.fromEffect(
        Effect.sleep(40).pipe(Effect.as(LLMEvent.textDelta({ id: "answer", text: "answer" }))),
      )
      expect(yield* SessionToolInputGuard.wrap(stream, { timeoutMs: 10 }).pipe(Stream.runCollect)).toHaveLength(1)
    }),
  )

  it.effect("allows an active argument stream beyond the default two-minute budget", () =>
    Effect.gen(function* () {
      const events = [
        started,
        ...Array.from({ length: 4 }, () => LLMEvent.toolInputDelta({ id: "call", name: "edit", text: "content" })),
        LLMEvent.toolInputEnd({ id: "call", name: "edit" }),
        LLMEvent.toolCall({ id: "call", name: "edit", input: { content: "content".repeat(4) } }),
      ]
      const stream = Stream.concat(
        Stream.make(events[0]),
        Stream.fromIterable(events.slice(1)).pipe(
          Stream.mapEffect((event) => Effect.sleep("1 minute").pipe(Effect.as(event))),
        ),
      )
      const fiber = yield* SessionToolInputGuard.wrap(stream).pipe(Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust("7 minutes")
      expect(yield* Fiber.join(fiber)).toEqual(events)
    }),
  )

  it.effect("tracks inactivity separately for parallel calls", () =>
    Effect.gen(function* () {
      const stream = Stream.concat(
        Stream.make(started, LLMEvent.toolInputStart({ id: "other", name: "write" })),
        Stream.fromIterable(
          Array.from({ length: 8 }, () => LLMEvent.toolInputDelta({ id: "other", name: "write", text: "progress" })),
        ).pipe(Stream.mapEffect((event) => Effect.sleep(40).pipe(Effect.as(event)))),
      )
      const fiber = yield* SessionToolInputGuard.wrap(stream, { timeoutMs: 100 }).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.forkChild,
      )
      yield* TestClock.adjust(400)
      const error = yield* Fiber.join(fiber)
      expect(error.reason.message).toContain("for edit: no argument progress")
      expect(error.reason.message).toContain("idle limit 100ms")
      expect(error.reason.message).toContain("not executed")
    }),
  )

  for (const event of [
    started,
    LLMEvent.toolInputDelta({ id: "call", name: "edit", text: "" }),
    LLMEvent.textDelta({ id: "answer", text: "Still working" }),
    LLMEvent.reasoningDelta({ id: "reasoning", text: "thinking" }),
  ]) {
    it.effect(`${event.type} without argument bytes does not extend an unfinished call`, () =>
      Effect.gen(function* () {
        const stream = Stream.concat(
          Stream.make(started),
          Stream.fromIterable(Array.from({ length: 8 }, () => event)).pipe(
            Stream.mapEffect((next) => Effect.sleep(40).pipe(Effect.as(next))),
          ),
        )
        const fiber = yield* SessionToolInputGuard.wrap(stream, { timeoutMs: 100 }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild,
        )
        yield* TestClock.adjust(400)
        expect((yield* Fiber.join(fiber)).reason.message).toContain("idle limit 100ms")
      }),
    )
  }
})
