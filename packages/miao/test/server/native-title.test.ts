import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { NativeEngine } from "@miao/server/native-engine"
import { generateNativeTitle, nativeTitlePrompt } from "@miao/server/native-session"

const prompted = { type: "session.next.prompted", data: { prompt: { text: "[Image 1] 修复后台电池雷达" } } }

const fakeNative = (events: unknown[], titled: string[]) =>
  ({
    history: () => Effect.succeed({ events, cursor: events.length, hasMore: false }),
    title: (input: { prompt: string }) =>
      Effect.sync(() => {
        titled.push(input.prompt)
      }),
  }) as unknown as Pick<NativeEngine.Interface, "history" | "title">

test("nativeTitlePrompt prefers the first user prompt and strips image markers", () => {
  expect(nativeTitlePrompt([prompted])).toBe("修复后台电池雷达")
})

test("nativeTitlePrompt falls back to the first assistant answer when the prompt is image-only", () => {
  const events = [
    { type: "session.next.prompted", data: { prompt: { text: "[Image 1]" } } },
    { type: "session.next.text.ended", data: { text: "The battery radar stream starts on port 9000." } },
  ]
  expect(nativeTitlePrompt(events)).toBe("The battery radar stream starts on port 9000.")
})

test("generateNativeTitle hands the derived prompt to the title hook", async () => {
  const titled: string[] = []
  const exit = await Effect.runPromiseExit(
    generateNativeTitle({
      native: fakeNative([prompted], titled),
      sessionID: "ses_x" as never,
      storage: "/tmp/x" as never,
      location: {} as never,
    }),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(titled).toEqual(["修复后台电池雷达"])
})

test("generateNativeTitle does not call the title hook without a prompt", async () => {
  const titled: string[] = []
  const exit = await Effect.runPromiseExit(
    generateNativeTitle({
      native: fakeNative([], titled),
      sessionID: "ses_x" as never,
      storage: "/tmp/x" as never,
      location: {} as never,
    }),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(titled).toEqual([])
})
