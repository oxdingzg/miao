import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { NativeEngine } from "@miao/server/native-engine"
import { generateNativeTitle, nativeTitlePrompt } from "@miao/server/native-session"

const prompted = { type: "session.next.prompted", data: { prompt: { text: "[Image 1] 修复后台电池雷达" } } }

const fakeNative = (events: unknown[], titled: string[], generated?: string, renamed: string[] = []) =>
  ({
    history: () => Effect.succeed({ events, cursor: events.length, hasMore: false }),
    title: (input: { prompt: string }) =>
      Effect.sync(() => {
        titled.push(input.prompt)
        return generated
      }),
    rename: (input: { title: string }) =>
      Effect.sync(() => {
        renamed.push(input.title)
      }),
  }) as unknown as Pick<NativeEngine.Interface, "history" | "title" | "rename">

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

test("generateNativeTitle renames the engine copy with the generated title", async () => {
  const titled: string[] = []
  const renamed: string[] = []
  const exit = await Effect.runPromiseExit(
    generateNativeTitle({
      native: fakeNative([prompted], titled, "修复后台电池雷达", renamed),
      sessionID: "ses_x" as never,
      storage: "/tmp/x" as never,
      location: {} as never,
    }),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(renamed).toEqual(["修复后台电池雷达"])
})

test("generateNativeTitle leaves the engine copy alone without a generated title", async () => {
  const titled: string[] = []
  const renamed: string[] = []
  const exit = await Effect.runPromiseExit(
    generateNativeTitle({
      native: fakeNative([prompted], titled, undefined, renamed),
      sessionID: "ses_x" as never,
      storage: "/tmp/x" as never,
      location: {} as never,
    }),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(renamed).toEqual([])
})


test("image-only native titles can find an answer beyond the first journal page", async () => {
  const named: string[] = []
  const native: Parameters<typeof generateNativeTitle>[0]["native"] = {
    ...fakeNative([], named),
    history: (input) => Effect.succeed(input.after === 0
      ? { events: [{ type: "session.next.prompted", data: { prompt: { text: "[Image 1]" } } }], cursor: 100, hasMore: true }
      : { events: [{ type: "session.next.text.ended", data: { text: "The screenshot shows a paused task." } }], cursor: 120, hasMore: false }) as never,
  }
  await Effect.runPromise(generateNativeTitle({ native, sessionID: "ses_page" as never, storage: "/tmp/paged-title" as never, location: {} as never }))
  expect(named).toEqual(["The screenshot shows a paused task."])
})
