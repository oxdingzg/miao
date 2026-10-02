/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const directory = "/tmp/opencode/packages/miao"
const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "race",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory, workspaceID: undefined },
  subpath: "",
}

function assistant(id: string, created: number, text: string, textID = `${id}_text`) {
  return {
    id,
    type: "assistant" as const,
    time: { created },
    agent: "build",
    model: { id: "model", providerID: "test" },
    content: [{ type: "text" as const, id: textID, text }],
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

// Any durable `session.next.*` event that is not a stream fragment schedules a
// re-hydration. Tests use an in-flight text start to trigger one on demand.
function refresh(id: string): GlobalEvent["payload"] {
  return {
    id,
    type: "session.next.text.started",
    properties: { timestamp: 1, sessionID, assistantMessageID: messageID, textID: partID },
  }
}

function routes(input: {
  context?: () => unknown[]
  history?: () => Response | Promise<Response>
  session?: () => unknown
}) {
  return (url: URL) => {
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: input.session?.() ?? session })
    if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: input.context?.() ?? [] })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return input.history ? input.history() : json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/todo` || url.pathname === `/api/session/${sessionID}/diff`)
      return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
    return undefined
  }
}

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { id: "msg_a", timestamp: 30 },
    { id: "msg_z", timestamp: 10 },
    { id: "msg_m", timestamp: 20 },
    { id: "msg_b", timestamp: 20 },
  ]

  try {
    for (const message of messages) {
      emit(
        global({
          id: `evt_${message.id}`,
          type: "session.next.prompted",
          properties: {
            timestamp: message.timestamp,
            sessionID,
            messageID: message.id,
            prompt: { text: message.id },
            delivery: "steer",
          },
        }),
      )
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveHistory!: (response: Response) => void
  const history = new Promise<Response>((resolve) => {
    resolveHistory = resolve
  })
  let requested = false
  const liveID = "msg_live"
  const { app, emit, sync } = await mount(
    routes({
      context: () => [{ id: liveID, type: "user", text: "", time: { created: 1 } }],
      history: () => {
        requested = true
        return history
      },
    }),
    tmp.path,
  )

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_live",
        type: "session.next.prompted",
        properties: {
          timestamp: 1,
          sessionID,
          messageID: liveID,
          prompt: { text: "visible live content" },
          delivery: "steer",
        },
      }),
    )
    await wait(() => sync.data.part[liveID]?.[0]?.type === "text")

    resolveHistory(json({ data: [], cursor: {} }))
    await hydrate

    expect(sync.data.part[liveID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveHistory!: (response: Response) => void
  const history = new Promise<Response>((resolve) => {
    resolveHistory = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount(
    routes({
      context: () => [assistant(messageID, 1, "hydrated", partID)],
      history: () => {
        requested = true
        return history
      },
    }),
    tmp.path,
  )

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "session.next.text.delta",
        properties: {
          timestamp: 2,
          sessionID,
          assistantMessageID: messageID,
          textID: partID,
          delta: "ignored until part exists",
        },
      }),
    )
    resolveHistory(json({ data: [], cursor: {} }))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let contextData: unknown[] = [assistant(messageID, 1, "", partID)]
  let contextRequests = 0
  const { app, emit, sync } = await mount(
    routes({
      context: () => {
        contextRequests += 1
        return contextData
      },
    }),
    tmp.path,
  )

  try {
    await sync.session.sync(sessionID)
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")
    emit(
      global({
        id: "evt_delta",
        type: "session.next.text.delta",
        properties: {
          timestamp: 2,
          sessionID,
          assistantMessageID: messageID,
          textID: partID,
          delta: "visible streamed content",
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")

    const before = contextRequests
    contextData = [assistant(messageID, 1, "", partID)]
    emit(global(refresh("evt_started")))
    await wait(() => contextRequests > before)
    await Bun.sleep(50)

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test("live messages merged during hydration keep the whole projected transcript", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveHistory!: (response: Response) => void
  const history = new Promise<Response>((resolve) => {
    resolveHistory = resolve
  })
  let requested = false
  const liveID = "msg_z_live"
  const { app, emit, sync } = await mount(
    routes({
      history: () => {
        requested = true
        return history
      },
    }),
    tmp.path,
  )

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_live",
        type: "session.next.prompted",
        properties: {
          timestamp: 999,
          sessionID,
          messageID: liveID,
          prompt: { text: "live" },
          delivery: "steer",
        },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === liveID) ?? false)
    resolveHistory(
      json({
        data: Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return assistant(id, index, id)
        }),
        cursor: {},
      }),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(101)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(liveID)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(true)
    expect(sync.data.part.msg_000).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let contextData: unknown[] = [assistant(messageID, 1, "stale", partID)]
  let contextRequests = 0
  const { app, emit, sync } = await mount(
    routes({
      context: () => {
        contextRequests += 1
        return contextData
      },
    }),
    tmp.path,
  )

  try {
    await sync.session.sync(sessionID)
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    contextData = []
    emit(global(refresh("evt_removed")))
    await wait(() => (sync.data.message[sessionID] ?? []).length === 0)
    await Bun.sleep(50)

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("hydration updates keyed transcript objects without remounting unchanged UI", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let contextData: unknown[] = [assistant(messageID, 1, "before", partID)]
  let contextRequests = 0
  const { app, emit, sync } = await mount(
    routes({
      context: () => {
        contextRequests += 1
        return contextData
      },
    }),
    tmp.path,
  )

  try {
    await sync.session.sync(sessionID)
    await wait(() => sync.data.part[messageID]?.length === 1)
    const message = sync.data.message[sessionID][0]
    const text = sync.data.part[messageID][0]

    const before = contextRequests
    contextData = [{ ...assistant(messageID, 1, "after", partID), cost: 1 }]
    emit(global(refresh("evt_identity")))
    await wait(() => contextRequests > before)
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === "after")

    expect(sync.data.message[sessionID][0]).toBe(message)
    expect(sync.data.part[messageID][0]).toBe(text)
    expect(message).toMatchObject({ cost: 1 })
    expect(text).toMatchObject({ text: "after" })
  } finally {
    app.renderer.destroy()
  }
})
