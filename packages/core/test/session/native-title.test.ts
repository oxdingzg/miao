import { describe, expect, test } from "bun:test"
import { LLMEvent, Model, type LLMRequest } from "@miao/llm"
import { AgentV2 } from "@miao/core/agent"
import { SessionNativeTitle } from "@miao/core/session/native-title"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { SessionSchema } from "@miao/core/session/schema"
import type { SessionID } from "@miao/schema/session-id"
import { DateTime, Effect, Stream } from "effect"

const DEFAULT_TITLE = "New session - 2026-10-23T00:00:00.000Z"

const llmStream = () =>
  Stream.make(
    LLMEvent.textStart({ id: "1" }),
    LLMEvent.textDelta({ id: "1", text: "Fix the login flake" }),
    LLMEvent.textEnd({ id: "1" }),
  ) as unknown as Stream.Stream<LLMEvent, never>

const makeDeps = (info: SessionSchema.Info, resolve?: SessionRunnerModel.Interface["resolve"]) => {
  const published: Array<{ readonly title: string }> = []
  const deps = {
    sessionID: "ses_title" as SessionID,
    prompt: "Fix the login flake",
    store: { get: () => Effect.succeed(info) },
    llm: { stream: (_request: LLMRequest) => llmStream() },
    agents: {
      get: () => Effect.succeed({ ...AgentV2.Info.empty(AgentV2.ID.make("title")), system: "one line only" }),
    },
    models: {
      resolve:
        resolve ??
        (() =>
          Effect.succeed({
            model: Model.make({ id: "test-model", provider: "test", route: {} as never }),
            info: undefined as never,
          })),
    },
    events: {
      publish: (
        definition: unknown,
        payload: { readonly sessionID: SessionID; readonly timestamp: DateTime.Utc; readonly title: string },
      ) => {
        published.push(payload)
        return Effect.void
      },
    },
  }
  return { published, deps }
}

const info = (title: string, parentID?: string) =>
  ({
    id: "ses_title" as unknown as SessionID,
    title,
    parentID,
    model: { providerID: "test", id: "test-model" },
  }) as unknown as SessionSchema.Info

describe("SessionNativeTitle", () => {
  test("publishes a generated title while the placeholder is still set", async () => {
    const info0 = info(DEFAULT_TITLE)
    const published: Array<{ readonly title: string }> = []
    const resolve: SessionRunnerModel.Interface["resolve"] = (session) =>
      Effect.succeed({
        model: Model.make({ id: "test-model", provider: "test", route: {} as never }),
        info: undefined as never,
      })
    const generated = await Effect.runPromise(
      SessionNativeTitle.afterRun({
        sessionID: info0.id,
        prompt: "Fix the login flake",
        store: { get: () => Effect.succeed(info0) },
        llm: { stream: () => llmStream() },
        agents: { get: () => Effect.succeed(undefined as never) },
        models: { resolve },
        events: {
          publish: (definition: unknown, payload: { readonly title: string }) => {
            published.push(payload)
            return Effect.void
          },
        },
      }),
    )
    expect(published).toHaveLength(1)
    expect(published[0]!.title).toBe("Fix the login flake")
    expect(generated).toBe("Fix the login flake")
  })

  test("skips sessions whose title was set on purpose", async () => {
    const info0 = info("Renamed by the user")
    const published: Array<{ readonly title: string }> = []
    await Effect.runPromise(
      SessionNativeTitle.afterRun({
        sessionID: info0.id,
        prompt: "Fix the login flake",
        store: { get: () => Effect.succeed(info0) },
        llm: { stream: () => llmStream() },
        agents: { get: () => Effect.succeed(undefined as never) },
        models: {
          resolve: (session) =>
            Effect.succeed({
              model: Model.make({ id: "test-model", provider: "test", route: {} as never }),
              info: undefined as never,
            }),
        },
        events: {
          publish: (definition: unknown, payload: { readonly title: string }) => {
            published.push(payload)
            return Effect.void
          },
        },
      }),
    )
    expect(published).toHaveLength(0)
  })

  test("skips child sessions", async () => {
    const info0 = info(DEFAULT_TITLE, "ses_parent")
    const published: Array<{ readonly title: string }> = []
    await Effect.runPromise(
      SessionNativeTitle.afterRun({
        sessionID: info0.id,
        prompt: "Fix the login flake",
        store: { get: () => Effect.succeed(info0) },
        llm: { stream: () => llmStream() },
        agents: { get: () => Effect.succeed(undefined as never) },
        models: {
          resolve: (session) =>
            Effect.succeed({
              model: Model.make({ id: "test-model", provider: "test", route: {} as never }),
              info: undefined as never,
            }),
        },
        events: {
          publish: (definition: unknown, payload: { readonly title: string }) => {
            published.push(payload)
            return Effect.void
          },
        },
      }),
    )
    expect(published).toHaveLength(0)
  })

  test("stays silent when the title model cannot be resolved", async () => {
    const info0 = info(DEFAULT_TITLE)
    const published: Array<{ readonly title: string }> = []
    await Effect.runPromise(
      SessionNativeTitle.afterRun({
        sessionID: info0.id,
        prompt: "Fix the login flake",
        store: { get: () => Effect.succeed(info0) },
        llm: { stream: () => llmStream() },
        agents: { get: () => Effect.succeed(undefined as never) },
        models: {
          resolve: (() =>
            Effect.fail(new Error("model unavailable"))) as unknown as SessionRunnerModel.Interface["resolve"],
        },
        events: {
          publish: (definition: unknown, payload: { readonly title: string }) => {
            published.push(payload)
            return Effect.void
          },
        },
      }),
    )
    expect(published).toHaveLength(0)
  })
})

test("legacy bare native placeholders are titled", async () => {
  const { deps, published } = makeDeps(info("New session"))
  await Effect.runPromise(SessionNativeTitle.afterRun(deps))
  expect(published[0]?.title).toBe("Fix the login flake")
})

test("an unavailable stored model falls back without carrying its credential pin", async () => {
  const seen: Array<SessionSchema.Info> = []
  const fixture = makeDeps(info("New session"))
  fixture.deps.models.resolve = (session) => {
    seen.push(session)
    return session.model
      ? Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id }))
      : Effect.succeed({
          model: Model.make({ id: "default-model", provider: "fixture", route: {} as never }),
          info: undefined as never,
        })
  }
  await Effect.runPromise(SessionNativeTitle.afterRun(fixture.deps))
  expect(fixture.published).toHaveLength(1)
  expect(seen.at(-1)?.model).toBeUndefined()
  expect(seen.at(-1)?.credentialID).toBeUndefined()
})

test("a failed auxiliary title model falls back to the session model", async () => {
  const fixture = makeDeps(info("New session"))
  fixture.deps.agents.get = () =>
    Effect.succeed({ model: { providerID: "fixture", id: "bad-title" }, system: "one line only" }) as never
  fixture.deps.models.resolve = (session) =>
    Effect.succeed({
      model: Model.make({ id: session.model!.id, provider: "fixture", route: {} as never }),
      info: undefined as never,
    })
  const requests: string[] = []
  fixture.deps.llm.stream = (request: LLMRequest) => {
    requests.push(request.model.id)
    return request.model.id === "bad-title" ? Stream.empty : llmStream()
  }
  await Effect.runPromise(SessionNativeTitle.afterRun(fixture.deps))
  expect(requests).toEqual(["bad-title", "test-model"])
  expect(fixture.published).toHaveLength(1)
})

test("a manual rename while the title model runs is preserved", async () => {
  const fixture = makeDeps(info("New session"))
  const state = { reads: 0 }
  fixture.deps.store.get = () => Effect.sync(() => info(state.reads++ === 0 ? "New session" : "User title"))
  await Effect.runPromise(SessionNativeTitle.afterRun(fixture.deps))
  expect(fixture.published).toHaveLength(0)
})

test("concurrent title requests share the guard before asynchronous store reads", async () => {
  const fixture = makeDeps(info("New session"))
  fixture.deps.store.get = () => Effect.yieldNow.pipe(Effect.as(info("New session")))
  await Effect.runPromise(
    Effect.all([SessionNativeTitle.afterRun(fixture.deps), SessionNativeTitle.afterRun(fixture.deps)], {
      concurrency: "unbounded",
    }),
  )
  expect(fixture.published).toHaveLength(1)
})
