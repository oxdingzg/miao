import { describe, expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import type { SessionApi, ServerApi, SessionMessageInfo } from "@/utils/server"
import type { retry } from "@miao/core/util/retry"
import type { OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import type { Session } from "@miao/schema/view-models"
import type { SessionReadClient } from "./server-session"
import { createServerSession } from "./server-session"

type MessageApi = ServerApi["messages"]
type UserRecord = Extract<SessionMessageInfo, { type: "user" }>
type AssistantRecord = Extract<SessionMessageInfo, { type: "assistant" }>
type RecordPage = { data: SessionMessageInfo[]; cursor: { previous?: string | null; next?: string | null } }

const session = (id: string, parentID?: string): Session => ({
  id,
  projectID: "project",
  location: { directory: "/repo" },
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  parentID,
  time: { created: 1, updated: 1 },
})

const userRecord = (id: string, input: Partial<UserRecord> = {}): UserRecord => ({
  id,
  type: "user",
  text: "text",
  time: { created: 1 },
  ...input,
})

const assistantRecord = (id: string, input: Partial<AssistantRecord> = {}): AssistantRecord => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [{ type: "text", id: "text", text: "text" }],
  time: { created: Number(id.at(-1)), completed: Number(id.at(-1)) },
  ...input,
})

const page = (data: SessionMessageInfo[], next?: string): RecordPage => ({
  data,
  cursor: { previous: null, next: next ?? null },
})

const deferredPage = () => Promise.withResolvers<RecordPage>()

function recordApi(...responses: Array<RecordPage | Promise<RecordPage>>) {
  let index = 0
  const requests: unknown[] = []
  const list = (input: unknown) => {
    requests.push(input)
    return responses[index++]
  }
  return Object.assign({ list }, { requests }) as unknown as MessageApi & { requests: unknown[] }
}

const recordStore = (api: MessageApi & { requests: unknown[] }, options?: { retry?: typeof retry }) =>
  createServerSession(
    {} as SessionReadClient,
    { get: async () => session("child") } as unknown as SessionApi,
    api,
    options,
  )

const retryImmediately: typeof retry = async (task, options = {}) => {
  const attempts = options.attempts ?? 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt === attempts - 1) throw error
    }
  }
}

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const messages: unknown[] = []
  const sessionApi = {
    get: async (input: unknown) => {
      get.push(input)
      return sessions[(input as { sessionID: string }).sessionID]
    },
  } as unknown as SessionApi
  const messageApi = {
    list: async (input: unknown) => {
      messages.push(input)
      return page([])
    },
  } as unknown as MessageApi
  return { get, messages, store: createServerSession({} as SessionReadClient, sessionApi, messageApi) }
}

const event = (input: object) => input as OpenCodeEventEncoded
const eventBase = { location: { directory: "/repo" }, durable: { aggregateID: "child", seq: 1, version: 1 } }

const prompted = (messageID: string, text: string, timestamp: number) =>
  event({
    ...eventBase,
    id: `evt_${messageID}`,
    type: "session.next.prompted",
    data: { timestamp, sessionID: "child", messageID, prompt: { text }, delivery: "steer" },
  })

const stepStarted = (assistantMessageID: string, timestamp: number) =>
  event({
    ...eventBase,
    id: `evt_step_${assistantMessageID}_${timestamp}`,
    type: "session.next.step.started",
    data: {
      timestamp,
      sessionID: "child",
      assistantMessageID,
      agent: "build",
      model: { id: "model", providerID: "provider" },
    },
  })

const textStarted = (assistantMessageID: string, textID: string, timestamp: number) =>
  event({
    ...eventBase,
    id: `evt_text_start_${textID}_${timestamp}`,
    type: "session.next.text.started",
    data: { timestamp, sessionID: "child", assistantMessageID, textID },
  })

const textDelta = (assistantMessageID: string, textID: string, delta: string, timestamp: number) =>
  event({
    ...eventBase,
    id: `evt_text_delta_${textID}_${timestamp}`,
    type: "session.next.text.delta",
    data: { timestamp, sessionID: "child", assistantMessageID, textID, delta },
  })

describe("server session", () => {
  test("restores the persisted V2 todo list after a reload", async () => {
    const todos = [
      { content: "Write the fix", status: "completed", priority: "high" },
      { content: "Verify it", status: "in_progress", priority: "medium" },
    ]
    const requests: unknown[] = []
    const client = {
      sessions: {
        todo: async (input: unknown) => {
          requests.push(input)
          return todos
        },
      },
    } as unknown as SessionReadClient
    // A fresh store models the page after a refresh: nothing is cached and no todo.updated event replays.
    const store = createServerSession(client)

    await store.todo("child")

    expect(requests).toEqual([{ sessionID: "child" }])
    expect(store.data.todo.child).toEqual(todos)

    await store.todo("child")
    expect(requests).toHaveLength(1)

    todos.splice(0, 1)
    await store.todo("child", { force: true })
    expect(requests).toHaveLength(2)
    expect(store.data.todo.child).toEqual([{ content: "Verify it", status: "in_progress", priority: "medium" }])
  })

  test("a todo snapshot that resolves after a live update does not revert it", async () => {
    const stale = [{ content: "old", status: "pending", priority: "low" }]
    const live = [{ content: "new", status: "in_progress", priority: "high" }]
    const snapshot = Promise.withResolvers<typeof stale>()
    const client = {
      sessions: {
        // The stale snapshot resolves only after the live event below.
        todo: () => snapshot.promise,
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    const loading = store.todo("child")
    store.apply({ type: "todo.updated", properties: { sessionID: "child", todos: live } })
    expect(store.data.todo.child?.[0]?.content).toBe("new")

    snapshot.resolve(stale)
    await loading
    expect(store.data.todo.child?.[0]?.content).toBe("new")
  })

  test("a reconnect refetches a cached todo list", async () => {
    const before = [{ content: "before", status: "pending", priority: "low" }]
    const after = [{ content: "after", status: "completed", priority: "high" }]
    let calls = 0
    const client = {
      sessions: {
        todo: async () => {
          calls += 1
          return calls === 1 ? before : after
        },
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    await store.todo("child")
    expect(store.data.todo.child?.[0]?.content).toBe("before")

    store.apply({ type: "server.connected" })
    const deadline = Date.now() + 500
    while (store.data.todo.child?.[0]?.content !== "after" && Date.now() < deadline) await Bun.sleep(5)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(store.data.todo.child?.[0]?.content).toBe("after")
  })

  test("a reconnect during the first todo fetch still refreshes after it settles", async () => {
    const stale = [{ content: "stale", status: "pending", priority: "low" }]
    const fresh = [{ content: "fresh", status: "completed", priority: "high" }]
    const first = Promise.withResolvers<typeof stale>()
    let calls = 0
    const client = {
      sessions: {
        todo: () => {
          calls += 1
          return calls === 1 ? first.promise : Promise.resolve(fresh)
        },
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    const loading = store.todo("child")
    // Reconnect while the pre-disconnect snapshot is still in flight.
    store.apply({ type: "server.connected" })
    first.resolve(stale)
    await loading

    const deadline = Date.now() + 500
    while (store.data.todo.child?.[0]?.content !== "fresh" && Date.now() < deadline) await Bun.sleep(5)
    expect(calls).toBe(2)
    expect(store.data.todo.child?.[0]?.content).toBe("fresh")
  })

  test("a reconnect does not apply a stale in-flight snapshot over cached todos", async () => {
    const cached = [{ content: "cached", status: "pending", priority: "low" }]
    const stale = [{ content: "stale", status: "pending", priority: "low" }]
    const fresh = [{ content: "fresh", status: "completed", priority: "high" }]
    const inFlight = Promise.withResolvers<typeof cached>()
    const afterReconnect = Promise.withResolvers<typeof cached>()
    let calls = 0
    const client = {
      sessions: {
        todo: () => {
          calls += 1
          if (calls === 1) return Promise.resolve(cached)
          if (calls === 2) return inFlight.promise
          return afterReconnect.promise
        },
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    await store.todo("child")
    expect(store.data.todo.child?.[0]?.content).toBe("cached")

    const refresh = store.todo("child", { force: true })
    store.apply({ type: "server.connected" })
    inFlight.resolve(stale)
    await refresh
    // The pre-reconnect snapshot must not replace the cached list.
    expect(store.data.todo.child?.[0]?.content).toBe("cached")

    afterReconnect.resolve(fresh)
    const deadline = Date.now() + 500
    while (store.data.todo.child?.[0]?.content !== "fresh" && Date.now() < deadline) await Bun.sleep(5)
    expect(calls).toBe(3)
    expect(store.data.todo.child?.[0]?.content).toBe("fresh")
  })

  test("a reconnect still fetches fresh when the pre-disconnect fetch rejects", async () => {
    const fresh = [{ content: "fresh", status: "completed", priority: "high" }]
    const first = Promise.withResolvers<typeof fresh>()
    let calls = 0
    const client = {
      sessions: {
        todo: () => {
          calls += 1
          return calls === 1 ? first.promise : Promise.resolve(fresh)
        },
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    const loading = store.todo("child")
    store.apply({ type: "server.connected" })
    first.reject(new Error("disconnected"))
    await loading.catch(() => {})

    const deadline = Date.now() + 500
    while (store.data.todo.child?.[0]?.content !== "fresh" && Date.now() < deadline) await Bun.sleep(5)
    expect(calls).toBe(2)
    expect(store.data.todo.child?.[0]?.content).toBe("fresh")
  })

  test("a reconnect does not resurrect todos for a session deleted while waiting", async () => {
    const cached = [{ content: "cached", status: "pending", priority: "low" }]
    const stale = [{ content: "stale", status: "pending", priority: "low" }]
    const inFlight = Promise.withResolvers<typeof cached>()
    let calls = 0
    const client = {
      sessions: {
        todo: () => {
          calls += 1
          return calls === 1 ? Promise.resolve(cached) : inFlight.promise
        },
      },
    } as unknown as SessionReadClient
    const store = createServerSession(client)

    await store.todo("child")
    expect(store.data.todo.child?.[0]?.content).toBe("cached")

    const refresh = store.todo("child", { force: true })
    store.apply({ type: "server.connected" })
    store.apply({ type: "session.deleted", properties: { sessionID: "child" } })
    inFlight.resolve(stale)
    await refresh
    await Bun.sleep(20)

    expect(store.data.todo.child).toBeUndefined()
    expect(calls).toBe(2)
  })

  test("projects V2 session events into message records", () => {
    const ctx = setup({ child: session("child") })
    ctx.store.remember(session("child"))
    ctx.store.set("message", "child", [userRecord("msg_1_user", { text: "hello" })])
    const apply = (input: object) => ctx.store.applyV2(event(input))

    apply(stepStarted("msg_2_assistant", 2))
    apply(textStarted("msg_2_assistant", "txt_1", 3))
    apply(textDelta("msg_2_assistant", "txt_1", "world", 4))

    // The client store wraps items in reactive proxies that bun's matchers
    // cannot subset-match against; compare the raw snapshot instead.
    expect(unwrap(ctx.store.data.message.child?.at(-1))).toMatchObject({
      id: "msg_2_assistant",
      type: "assistant",
      content: [{ type: "text", text: "world" }],
    })
    expect(ctx.store.data.message.child?.map((message) => message.id)).toEqual(["msg_1_user", "msg_2_assistant"])
  })

  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  test("loads session content through the message API", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
    expect(ctx.messages).toEqual([{ sessionID: "root", limit: 20, order: "desc" }])
    expect(ctx.store.data.message.root).toEqual([])
  })

  test("loads current session content through the current message API", async () => {
    const requests: unknown[] = []
    const user = { id: "msg_z_user", type: "user", text: "hello", time: { created: 1 } }
    const assistant = {
      id: "msg_a_assistant",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text", id: "txt_1", text: "hi" }],
      time: { created: 2, completed: 3 },
    }
    const messageApi = {
      list: async (input: unknown) => {
        requests.push(input)
        return { data: [assistant, user], cursor: { previous: null, next: null } }
      },
    } as unknown as MessageApi
    const store = createServerSession({} as SessionReadClient, {} as SessionApi, messageApi)
    store.remember(session("root"))

    await store.sync("root")

    expect(requests).toEqual([{ sessionID: "root", limit: 20, order: "desc" }])
    expect(store.data.message.root.map((message) => message.id)).toEqual([user.id, assistant.id])
  })

  test("extends a current page to include the user for split assistant turns", async () => {
    const user = { id: "msg_1_user", type: "user", text: "hello", time: { created: 1 } } as const
    const assistant = (id: string, created: number) => ({
      id,
      type: "assistant" as const,
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text" as const, id: `${id}_text`, text: id }],
      time: { created, completed: created },
    })
    const assistants = [
      assistant("msg_2_assistant", 2),
      assistant("msg_3_assistant", 3),
      assistant("msg_4_assistant", 4),
    ]
    const pages = [
      { data: assistants.slice(1).toReversed(), cursor: { previous: null, next: "older" } },
      { data: [assistants[0], user], cursor: { previous: null, next: null } },
    ]
    const requests: unknown[] = []
    const messageApi = {
      list: async (input: unknown) => {
        requests.push(input)
        return pages.shift()!
      },
    } as unknown as MessageApi
    const store = createServerSession({} as SessionReadClient, {} as SessionApi, messageApi)
    store.remember(session("root"))

    await store.sync("root")

    expect(requests).toEqual([
      { sessionID: "root", limit: 20, order: "desc" },
      { sessionID: "root", limit: 20, cursor: "older" },
    ])
    expect(store.data.message.root.map((message) => message.id)).toEqual([
      user.id,
      ...assistants.map((item) => item.id),
    ])
  })

  test("follows pagination until an assistant-only page reaches its user root", async () => {
    const user = userRecord("message-1")
    const assistants = [assistantRecord("message-2"), assistantRecord("message-3")]
    const api = recordApi(page([assistants[1], assistants[0]], "older"), page([user]))
    const store = recordStore(api)
    store.remember(session("child"))

    await store.sync("child")

    expect(api.requests).toEqual([
      { sessionID: "child", limit: 20, order: "desc" },
      { sessionID: "child", limit: 20, cursor: "older" },
    ])
    expect(store.data.message.child?.map((message) => message.id)).toEqual([
      user.id,
      ...assistants.map((item) => item.id),
    ])
    expect(store.history.more("child")).toBe(false)
  })

  test("keeps assistant history when pagination ends without a user root", async () => {
    const assistant = assistantRecord("message-2")
    const api = recordApi(page([assistant], "older"), page([]))
    const store = recordStore(api)
    store.remember(session("child"))

    await store.sync("child")

    expect(store.data.message.child?.map((message) => message.id)).toEqual([assistant.id])
    expect(store.history.more("child")).toBe(false)
  })

  test("confirms an optimistic user reached by pagination", async () => {
    const user = userRecord("message-1")
    const assistants = [assistantRecord("message-2"), assistantRecord("message-3")]
    const api = recordApi(page([assistants[1], assistants[0]], "older"), page([user]))
    const store = recordStore(api)
    store.remember(session("child"))
    store.optimistic.add({ sessionID: "child", message: user })

    await store.sync("child")
    store.optimistic.remove({ sessionID: "child", messageID: user.id })

    expect(api.requests).toHaveLength(2)
    expect(store.data.message.child?.map((message) => message.id)).toEqual([
      user.id,
      ...assistants.map((item) => item.id),
    ])
  })

  test("reaches a fetched assistant's parent through pagination when another user is cached", async () => {
    const unrelated = userRecord("message-0", { time: { created: 0 } })
    const user = userRecord("message-1")
    const assistants = [assistantRecord("message-2"), assistantRecord("message-3")]
    const api = recordApi(
      page([unrelated]),
      page([assistants[1], assistants[0]], "older"),
      page([user, unrelated]),
    )
    const store = recordStore(api)
    store.remember(session("child"))

    await store.sync("child")

    await store.sync("child", { force: true })

    expect(api.requests).toHaveLength(3)
    expect(store.data.message.child?.map((message) => message.id)).toEqual([
      unrelated.id,
      user.id,
      ...assistants.map((item) => item.id),
    ])
  })

  test("preserves cached history between an injected parent and the page boundary", async () => {
    const user = userRecord("message-1")
    const cached = userRecord("message-3", { time: { created: 3 } })
    const assistant = assistantRecord("message-4")
    const api = recordApi(page([cached]), page([assistant], "older"), page([cached, user]))
    const store = recordStore(api)
    store.remember(session("child"))

    await store.sync("child")

    await store.sync("child", { force: true })

    expect(store.data.message.child?.map((message) => message.id)).toEqual([user.id, cached.id, assistant.id])
  })

  test("refreshes a cached parent reached through pagination past an assistant page", async () => {
    const stale = userRecord("message-1", { text: "stale" })
    const fresh = userRecord("message-1", { text: "fresh" })
    const assistant = assistantRecord("message-2")
    const api = recordApi(page([stale]), page([assistant], "older"), page([fresh]))
    const store = recordStore(api)
    store.remember(session("child"))

    await store.sync("child")

    await store.sync("child", { force: true })

    expect(api.requests).toHaveLength(3)
    expect(store.data.message.child).toEqual([fresh, assistant])
  })

  test("merges a parent received by SSE during the initial load", async () => {
    const pending = deferredPage()
    const user = userRecord("message-1")
    const assistant = assistantRecord("message-2")
    const api = recordApi(pending.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    const loading = store.sync("child")

    store.applyV2(prompted("message-1", user.text, 1))
    pending.resolve(page([assistant]))
    await loading

    expect(api.requests).toHaveLength(1)
    expect(store.data.message.child?.map((message) => message.id)).toEqual([user.id, assistant.id])
  })

  test("preserves events received during a failed page retry", async () => {
    const user = userRecord("message-1")
    const fetched = assistantRecord("message-2", { time: { created: 2, completed: 2 } })
    const api = recordApi(Promise.reject(new Error("retry")), page([fetched]))
    const store = recordStore(api, { retry: retryImmediately })
    store.remember(session("child"))
    const loading = store.sync("child")

    store.applyV2(prompted("message-1", user.text, 1))
    store.applyV2(stepStarted("message-2", 2))
    await loading

    expect(api.requests).toHaveLength(2)
    expect(store.data.message.child?.map((message) => message.id)).toEqual([user.id, "message-2"])
    expect(unwrap(store.data.message.child?.at(-1))).toMatchObject({ content: [], time: { created: 2 } })
  })

  test("preserves unrelated prompts across a failed page retry", async () => {
    const user = userRecord("message-1")
    const live = userRecord("message-4", { time: { created: 4 } })
    const assistant = assistantRecord("message-2")
    const api = recordApi(Promise.reject(new Error("retry")), page([assistant]))
    const store = recordStore(api, { retry: retryImmediately })
    store.remember(session("child"))
    const loading = store.sync("child")

    store.applyV2(prompted("message-1", user.text, 1))
    store.applyV2(prompted("message-4", live.text, 4))
    await loading

    expect(api.requests).toHaveLength(2)
    expect(store.data.message.child?.map((message) => message.id)).toEqual([user.id, live.id, assistant.id])
  })

  test("merges live events into the initial page", async () => {
    const pending = deferredPage()
    const user = userRecord("message-1")
    const live = userRecord("message-2", { time: { created: 2 } })
    const api = recordApi(pending.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    const loading = store.sync("child")

    store.applyV2(prompted("message-2", live.text, 2))
    pending.resolve(page([user]))
    await loading

    expect(store.data.message.child?.map((message) => message.id)).toEqual([live.id, user.id])
  })

  test("preserves same-ID live updates over the initial page", async () => {
    const pending = deferredPage()
    const fetched = userRecord("message", { text: "fetched" })
    const api = recordApi(pending.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    const loading = store.sync("child")

    store.applyV2(prompted("message", "live", 2))
    pending.resolve(page([fetched]))
    await loading

    expect(store.data.message.child?.map((message) => message.id)).toEqual(["message"])
    expect(unwrap(store.data.message.child?.at(0))).toMatchObject({ text: "live" })
  })

  test("discards a load evicted by session deletion", async () => {
    const first = deferredPage()
    const second = deferredPage()
    const message = userRecord("message")
    const api = recordApi(first.promise, second.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    const initial = store.sync("child")

    store.apply({ type: "session.deleted", properties: { sessionID: "child", info: session("child", "root") } })
    const replacement = store.sync("child")

    first.resolve(page([userRecord("message-a")]))
    await initial
    second.resolve(page([message]))
    await replacement

    expect(store.data.message.child?.map((item) => item.id)).toEqual([message.id])
  })

  test("keeps a prompt applied during a refresh that omits it", async () => {
    const pending = deferredPage()
    const message = userRecord("message")
    const api = recordApi(page([message]), pending.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.applyV2(prompted("message-2", "live", 2))
    pending.resolve(page([message]))
    await refreshing

    expect(store.data.message.child?.map((item) => item.id)).toEqual(["message-2", message.id])
  })

  test("preserves event content outside an incomplete initial page", async () => {
    const live = userRecord("message-1")
    const fetched = userRecord("message-2", { time: { created: 2 } })
    const api = recordApi(page([fetched], "older"))
    const store = recordStore(api)
    store.remember(session("child"))
    store.applyV2(prompted("message-1", live.text, 1))

    await store.sync("child")

    expect(store.data.message.child?.map((message) => message.id)).toEqual([live.id, fetched.id])
  })

  test("replaces confirmed optimistic content with the initial page", async () => {
    const optimistic = userRecord("message", { time: { created: 1 } })
    const fetched = userRecord("message", { time: { created: 2 } })
    const api = recordApi(page([fetched]))
    const store = recordStore(api)
    store.remember(session("child"))
    store.optimistic.add({ sessionID: "child", message: optimistic })

    await store.sync("child")

    expect(store.data.message.child?.map((message) => message.time.created)).toEqual([2])
  })

  test("propagates message load failure after retries are exhausted", async () => {
    const api = recordApi(
      Promise.reject(new Error("failed to fetch")),
      Promise.reject(new Error("failed to fetch")),
      Promise.reject(new Error("failed to fetch")),
    )
    const store = recordStore(api, { retry: retryImmediately })
    store.remember(session("child"))

    const failure = await store.sync("child").catch((error) => error)

    expect(api.requests).toHaveLength(3)
    expect(failure).toBeInstanceOf(Error)
  })

  test("preserves live updates during a forced refresh", async () => {
    const pending = deferredPage()
    const stale = assistantRecord("message-2", {
      content: [{ type: "text", id: "txt_1", text: "hi" }],
      time: { created: 2, completed: 2 },
    })
    const api = recordApi(page([stale]), pending.promise)
    const store = recordStore(api)
    store.remember(session("child"))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.applyV2(stepStarted("message-2", 3))
    store.applyV2(textStarted("message-2", "txt_2", 3))
    store.applyV2(textDelta("message-2", "txt_2", "world", 4))
    pending.resolve(page([stale]))
    await refreshing

    expect(unwrap(store.data.message.child?.at(0))).toMatchObject({
      content: [
        { type: "text", text: "hi" },
        { type: "text", text: "world" },
      ],
      time: { created: 2 },
    })
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { sessionID: "root", info: session("root") } })
    ctx.store.applyV2(
      event({
        id: "evt_status",
        type: "session.next.status",
        location: { directory: "/repo" },
        data: { timestamp: 1, sessionID: "root", status: { type: "busy" } },
      }),
    )

    expect(ctx.store.get("root")?.location.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
    expect(ctx.get).toEqual([])
  })

  test("preserves pinned session content under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.optimistic.add({ sessionID: "active", message: userRecord("message") })

    for (let index = 0; index < 50; index++) {
      ctx.store.remember(session(`session-${index}`))
      ctx.store.apply({
        type: "todo.updated",
        properties: { sessionID: `session-${index}`, todos: [] },
      })
    }

    expect(ctx.store.data.message.active?.map((message) => message.id)).toEqual(["message"])
    expect(ctx.store.data.todo["session-0"]).toBeUndefined()
  })
})
