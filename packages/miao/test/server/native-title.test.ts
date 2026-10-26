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

test("an explicit wait joins the background title through native title persistence", async () => {
  const { Deferred, Fiber, Stream } = await import("effect")
  const { SessionNativeTitle } = await import("@miao/core/session/native-title")
  const { LLMEvent, Model } = await import("@miao/llm")
  const state = { title: "New session", calls: 0, waiterFinished: false }
  const renamed: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const renameStarted = yield* Deferred.make<void>()
        const persist = yield* Deferred.make<void>()
        const launched = yield* Deferred.make<void>()
        const input = {
          sessionID: "ses_join_title" as never,
          storage: "/tmp/title-join" as never,
          location: {} as never,
          native: {
            ...fakeNative([prompted], []),
            title: () =>
              SessionNativeTitle.afterRun({
                sessionID: "ses_join_title" as never,
                prompt: "fixture",
                store: {
                  get: () =>
                    Effect.succeed({
                      id: "ses_join_title",
                      title: state.title,
                      model: { providerID: "fixture", id: "fixture" },
                    } as never),
                },
                agents: { get: () => Effect.succeed(undefined as never) },
                models: {
                  resolve: () =>
                    Effect.succeed({
                      model: Model.make({ provider: "fixture", id: "fixture", route: {} as never }),
                      info: undefined as never,
                    }),
                },
                llm: {
                  stream: () =>
                    Stream.fromEffect(
                      Effect.gen(function* () {
                        state.calls++
                        yield* Deferred.succeed(started, undefined)
                        yield* Deferred.await(release)
                      }),
                    ).pipe(
                      Stream.flatMap(() =>
                        Stream.make(
                          LLMEvent.textStart({ id: "title" }),
                          LLMEvent.textDelta({ id: "title", text: "Joined native title" }),
                          LLMEvent.textEnd({ id: "title" }),
                        ),
                      ),
                    ),
                },
                events: {
                  publish: (_, payload) =>
                    Effect.sync(() => {
                      state.title = payload.title
                    }),
                },
              }),
            rename: ({ title }: { title: string }) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(renameStarted, undefined)
                yield* Deferred.await(persist)
                renamed.push(title)
              }),
          },
        }
        const background = yield* generateNativeTitle(input).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        const waiter = yield* Deferred.succeed(launched, undefined).pipe(
          Effect.andThen(generateNativeTitle(input)),
          Effect.tap(() =>
            Effect.sync(() => {
              state.waiterFinished = true
            }),
          ),
          Effect.forkScoped,
        )
        yield* Deferred.await(launched)
        yield* Effect.yieldNow
        expect(state.waiterFinished).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(renameStarted)
        expect(state.waiterFinished).toBe(false)
        expect(renamed).toEqual([])
        yield* Deferred.succeed(persist, undefined)
        yield* Fiber.join(background)
        yield* Fiber.join(waiter)
      }),
    ),
  )
  expect(state.calls).toBe(1)
  expect(renamed).toEqual(["Joined native title"])
})

test("title joins isolate native storage and release cancelled work for retry", async () => {
  const { Deferred, Fiber } = await import("effect")
  const renamed: string[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const launched = yield* Deferred.make<void>()
    const base = { sessionID: "ses_cancel_title" as never, location: {} as never }
    const waiting = {
      ...base, storage: "/tmp/title-cancel" as never,
      native: { ...fakeNative([prompted], []), title: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) },
    }
    const owner = yield* generateNativeTitle(waiting).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* generateNativeTitle({ ...base, storage: "/tmp/title-other" as never, native: fakeNative([prompted], [], "Other storage", renamed) }).pipe(Effect.timeout("1 second"))
    expect(renamed).toEqual(["Other storage"])
    const joined = yield* Deferred.succeed(launched, undefined).pipe(Effect.andThen(generateNativeTitle(waiting)), Effect.forkScoped)
    yield* Deferred.await(launched)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(owner)
    yield* Fiber.join(joined).pipe(Effect.timeout("1 second"))
    yield* generateNativeTitle({ ...base, storage: waiting.storage, native: fakeNative([prompted], [], "Retry title", renamed) }).pipe(Effect.timeout("1 second"))
  })))
  expect(renamed).toEqual(["Other storage", "Retry title"])
})
