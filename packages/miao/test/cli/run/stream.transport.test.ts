import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PermissionV2Request, QuestionV2Request, SessionMessage } from "@miao/schema/view-models"
import { createClient } from "@/client"
import { createSessionTransport } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, LocalReplayRow, RunFilePart, StreamCommit } from "@/cli/cmd/run/types"

type EventStream = AsyncGenerator<StreamEvent>
type EventSubscribe = () => Promise<{ stream: EventStream }>
type Assistant = Extract<SessionMessage, { type: "assistant" }>
type Content = Assistant["content"][number]
type Event = { type: string; properties: Record<string, unknown> }
// The `/api/event` wire shape.
type StreamEvent = { type: string; data: Record<string, unknown> }

afterEach(() => {
  mock.restore()
})

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

async function waitFor<T>(check: () => T | undefined, timeout = 1_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value !== undefined) {
      return value
    }

    await Bun.sleep(10)
  }

  throw new Error("timed out waiting for value")
}

// V2 session events, in the encoded form the server streams.
function next(type: string, properties: Record<string, unknown>, sessionID = "session-1"): Event {
  return { type: `session.next.${type}`, properties: { sessionID, timestamp: 1, ...properties } }
}

function busy(sessionID = "session-1") {
  return next("status", { status: { type: "busy" } }, sessionID)
}

function idle(sessionID = "session-1") {
  return next("status", { status: { type: "idle" } }, sessionID)
}

function step(messageID: string, sessionID = "session-1") {
  return next(
    "step.started",
    { assistantMessageID: messageID, agent: "build", model: { providerID: "openai", id: "gpt-5" } },
    sessionID,
  )
}

function textStarted(messageID: string, textID: string, sessionID = "session-1") {
  return next("text.started", { assistantMessageID: messageID, textID }, sessionID)
}

function textDelta(messageID: string, textID: string, delta: string, sessionID = "session-1") {
  return next("text.delta", { assistantMessageID: messageID, textID, delta }, sessionID)
}

function textEnded(messageID: string, textID: string, text: string, sessionID = "session-1") {
  return next("text.ended", { assistantMessageID: messageID, textID, text }, sessionID)
}

function toolCalled(input: {
  messageID: string
  callID: string
  tool: string
  body: Record<string, unknown>
  sessionID?: string
}) {
  return next(
    "tool.called",
    {
      assistantMessageID: input.messageID,
      callID: input.callID,
      tool: input.tool,
      input: input.body,
      provider: { executed: false },
    },
    input.sessionID,
  )
}

function toolSuccess(input: {
  messageID: string
  callID: string
  structured?: Record<string, unknown>
  output?: string
  sessionID?: string
}) {
  return next(
    "tool.success",
    {
      assistantMessageID: input.messageID,
      callID: input.callID,
      structured: input.structured ?? {},
      content: input.output === undefined ? [] : [{ type: "text", text: input.output }],
      provider: { executed: false },
    },
    input.sessionID,
  )
}

function created(sessionID: string, parentID: string) {
  return next("created", { info: { id: sessionID, parentID } }, sessionID)
}

// Projected V2 transcript messages, as the context route returns them.
function assistantMessage(input: { id: string; content: Content[]; completed?: number }): SessionMessage {
  return {
    id: input.id,
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    time: { created: 1, ...(input.completed === undefined ? {} : { completed: input.completed }) },
    content: input.content,
  }
}

function text(id: string, value: string): Content {
  return { type: "text", id, text: value }
}

function reasoning(id: string, value: string): Content {
  return { type: "reasoning", id, text: value }
}

function runningTool(callID: string, name: string, input: Record<string, unknown>): Content {
  return {
    type: "tool",
    id: callID,
    name,
    state: { status: "running", input, structured: {}, content: [] },
    time: { created: 1, ran: 1 },
  }
}

function completedTool(
  callID: string,
  name: string,
  input: Record<string, unknown>,
  structured: Record<string, unknown> = {},
): Content {
  return {
    type: "tool",
    id: callID,
    name,
    state: { status: "completed", input, structured, content: [{ type: "text", text: "" }] },
    time: { created: 1, ran: 1, completed: 2 },
  }
}

const StreamClosed = undefined as never

function feed<T, R = never>(returnValue: R = StreamClosed) {
  const list: T[] = []
  let done = false
  let wake: (() => void) | undefined

  const wrapped = (async function* (): AsyncGenerator<T, R, unknown> {
    while (!done || list.length > 0) {
      if (list.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }

      const value = list.shift()
      if (!value) {
        continue
      }

      yield value
    }
    return returnValue as R
  })()

  return {
    stream: wrapped,
    push(value: T) {
      list.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      done = true
      wake?.()
      wake = undefined
    },
  }
}

// Session events in the `/api/event` shape the transport reads.
function eventFeed() {
  const source = feed<StreamEvent>()
  return {
    stream: source.stream,
    push: (event: Event) => source.push(streamEvent(event)),
    close: source.close,
  }
}

function streamEvent(event: Event): StreamEvent {
  return { type: event.type, data: event.properties }
}

function ok<const T>(data: T) {
  return Promise.resolve(data)
}

function footer(fn?: (commit: StreamCommit) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false
  let idleCalls = 0

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event(value) {
      events.push(value)
    },
    append(value) {
      commits.push(value)
      fn?.(value)
    },
    idle() {
      idleCalls += 1
      return Promise.resolve()
    },
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }

  return {
    api,
    commits,
    events,
    get idleCalls() {
      return idleCalls
    },
  }
}

type Calls = {
  prompt: unknown[]
  command: unknown[]
  shell: unknown[]
  agent: unknown[]
  model: unknown[]
}

// A client whose V2 session routes are stubbed. The transcript loader backs the
// context route (the messages timeline stays empty, so each transcript read
// is one loader call), and blocker lists are per session like the V2 routes.
function sdk(
  input: {
    stream?: EventStream
    subscribe?: EventSubscribe
    transcript?: (sessionID: string) => Promise<SessionMessage[]> | SessionMessage[]
    children?: (sessionID: string) => Array<{ id: string }>
    session?: { agent?: string; model?: { providerID: string; id: string; variant?: string } }
    status?: () => Promise<"busy" | "idle"> | "busy" | "idle"
    permissions?: (sessionID: string) => PermissionV2Request[]
    questions?: (sessionID: string) => Promise<QuestionV2Request[]> | QuestionV2Request[]
    prompt?: (params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    command?: (params: unknown) => Promise<unknown>
    shell?: (params: unknown) => Promise<unknown>
  } = {},
) {
  const client = createClient({ baseUrl: "http://localhost:4096" })
  const calls: Calls = { prompt: [], command: [], shell: [], agent: [], model: [] }
  const session = client.sessions
  const stub = (target: object, name: string, impl: (...args: never[]) => unknown) => {
    spyOn(target as Record<string, (...args: never[]) => unknown>, name).mockImplementation(impl)
  }

  stub(client.events, "subscribe", () => ({
    async *[Symbol.asyncIterator]() {
      const subscribed = await (input.subscribe?.() ??
        Promise.resolve({
          stream: input.stream ?? (async function* (): AsyncGenerator<StreamEvent> {})(),
        }))
      yield* subscribed.stream
    },
  }))
  stub(session, "context", async (params: { sessionID: string }) =>
    ok(await (input.transcript?.(params.sessionID) ?? [])),
  )
  stub(client.messages, "list", () => ok({ data: [], cursor: {} }))
  stub(session, "children", (params: { sessionID: string }) =>
    ok(
      (input.children?.(params.sessionID) ?? []).map((child) => ({
        id: child.id,
        parentID: params.sessionID,
        projectID: "project-1",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        title: child.id,
        location: { directory: "/tmp" },
      })),
    ),
  )
  stub(session, "get", () => ok({ id: "session-1", title: "t", location: { directory: "/tmp" }, ...input.session }))
  stub(session, "status", async () => ok({ type: (await input.status?.()) ?? "idle" }))
  stub(client.permissions, "list", (params: { sessionID: string }) => ok(input.permissions?.(params.sessionID) ?? []))
  stub(client.questions, "list", async (params: { sessionID: string }) =>
    ok(await (input.questions?.(params.sessionID) ?? [])),
  )
  stub(session, "prompt", (params: unknown, options?: { signal?: AbortSignal }) => {
    calls.prompt.push(params)
    return (input.prompt?.(params, options) ?? Promise.resolve()).then(() => ok({ admittedSeq: 1 }))
  })
  stub(session, "command", (params: unknown) => {
    calls.command.push(params)
    return (input.command?.(params) ?? Promise.resolve()).then(() => ok(undefined))
  })
  stub(session, "shell", (params: unknown) => {
    calls.shell.push(params)
    return (input.shell?.(params) ?? Promise.resolve()).then(() => ok(undefined))
  })
  stub(session, "switchAgent", (params: unknown) => {
    calls.agent.push(params)
    return ok(undefined)
  })
  stub(session, "switchModel", (params: unknown) => {
    calls.model.push(params)
    return ok(undefined)
  })

  return { client, calls }
}

function turn(
  textValue: string,
  extra: Partial<Parameters<Awaited<ReturnType<typeof createSessionTransport>>["runPromptTurn"]>[0]> = {},
) {
  return {
    agent: undefined,
    model: undefined,
    variant: undefined,
    prompt: { text: textValue, parts: [] },
    files: [],
    includeFiles: false,
    ...extra,
  }
}

function lastSubagent(ui: ReturnType<typeof footer>) {
  const item = ui.events.findLast((event) => event.type === "stream.subagent")
  return item?.type === "stream.subagent" ? item.state : undefined
}

describe("run stream transport", () => {
  test("does not replay persisted main-session history during bootstrap by default", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [assistantMessage({ id: "msg-1", content: [text("text-1", "Hello.")], completed: 2 })]
            : [],
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      expect(ui.commits).toEqual([])
      expect(ui.idleCalls).toBe(0)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replays persisted main-session history during bootstrap when enabled", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [assistantMessage({ id: "msg-1", content: [text("text-1", "Hello.")], completed: 2 })]
            : [],
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const commit = await waitFor(() => ui.commits.find((item) => item.kind === "assistant" && item.text === "Hello."))
      expect(commit.partID).toBe("msg-1:text-1")
      expect(ui.idleCalls).toBeGreaterThan(0)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("caps replayed bootstrap history to the configured number of messages", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [
                assistantMessage({ id: "msg-1", content: [text("text-0", "Hello.")], completed: 2 }),
                assistantMessage({ id: "msg-2", content: [text("text-0", "World.")], completed: 4 }),
              ]
            : [],
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      replayLimit: 1,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({ text: "World." }),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replays a finished session as idle", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => [
          assistantMessage({
            id: "msg-1",
            content: [reasoning("r-0", "think"), text("text-0", "Done.")],
            completed: 3,
          }),
        ],
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => ui.commits.find((item) => item.text === "Done."))
      const patch = ui.events.findLast((event) => event.type === "stream.patch")
      expect(patch?.type === "stream.patch" ? patch.patch.phase : undefined).not.toBe("running")
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("skips buffered pre-bootstrap deltas already covered by replay history", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: async (sessionID) => {
          if (sessionID !== "session-1") {
            return []
          }

          await gate.promise
          return [assistantMessage({ id: "msg-1", content: [text("text-1", "")] })]
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(textDelta("msg-1", "text-1", "Hello"))
      gate.resolve()
      transport = await task

      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      await Bun.sleep(20)
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({ text: "Hello" }),
      ])
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("preserves running footer state for resumed active sessions", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [assistantMessage({ id: "msg-1", content: [runningTool("call-1", "bash", { command: "pwd" })] })]
            : [],
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const patch = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.patch")
        return item?.type === "stream.patch" ? item.patch : undefined
      })

      expect(patch).toEqual(expect.objectContaining({ phase: "running", status: "running bash" }))
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rebuilds session output on resize and continues live deltas from replayed state", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => {
          calls += 1
          if (calls === 1) {
            return []
          }

          return [assistantMessage({ id: "msg-1", content: [text("text-1", "")] })]
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const localRows: LocalReplayRow[] = [
      { commit: { kind: "user", text: "pending prompt", phase: "start", source: "system", messageID: "msg-pending" } },
    ]
    const reset = mock(() => {
      localRows.push({
        commit: {
          kind: "user",
          text: "sent during reset",
          phase: "start",
          source: "system",
          messageID: "msg-during-reset",
        },
      })
      return Promise.resolve()
    })

    try {
      src.push(step("msg-1"))
      src.push(textStarted("msg-1", "text-1"))
      src.push(textDelta("msg-1", "text-1", "Hello"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === "Hello"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => localRows, reset })).toBe(true)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(ui.commits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", text: "Hello" }),
          expect.objectContaining({ kind: "user", text: "sent during reset", messageID: "msg-during-reset" }),
        ]),
      )

      src.push(textDelta("msg-1", "text-1", " world"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === " world"))
      expect(ui.commits.filter((commit) => commit.kind === "assistant").map((commit) => commit.text)).toEqual([
        "Hello",
        " world",
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("coalesces active resize requests into one trailing replay", async () => {
    const src = eventFeed()
    const ui = footer()
    const firstReset = defer()
    const resetA = mock(() => firstReset.promise)
    const resetB = mock(() => Promise.resolve())
    const resetC = mock(() => Promise.resolve())
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const active = transport.replayOnResize({ localRows: () => [], reset: resetA })
      await waitFor(() => (resetA.mock.calls.length === 1 ? true : undefined))

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetB })).toBe(false)
      expect(await transport.replayOnResize({ localRows: () => [], reset: resetC })).toBe(false)
      expect(resetB).not.toHaveBeenCalled()

      firstReset.resolve()
      expect(await active).toBe(true)
      expect(resetA).toHaveBeenCalledTimes(1)
      expect(resetB).not.toHaveBeenCalled()
      expect(resetC).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("keeps coalescing resize requests while buffered events drain", async () => {
    const src = eventFeed()
    const ui = footer()
    const firstReset = defer()
    const statusGate = defer()
    const statusStarted = defer()
    let blockStatus = false
    const trace = mock((_type: string, _data?: unknown) => {})
    const resetA = mock(() => firstReset.promise)
    const resetB = mock(() => Promise.resolve())
    const resetC = mock(() => Promise.resolve())
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        status: async () => {
          if (blockStatus) {
            statusStarted.resolve()
            await statusGate.promise
          }
          return "busy" as const
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
      trace: { write: trace },
    })
    const active = transport.runPromptTurn(turn("active"))

    try {
      await waitFor(() => ui.events.find((event) => event.type === "turn.wait"))
      const resize = transport.replayOnResize({ localRows: () => [], reset: resetA })
      await waitFor(() => (resetA.mock.calls.length === 1 ? true : undefined))
      blockStatus = true
      src.push(busy())
      src.push(idle())
      await waitFor(() => (trace.mock.calls.filter((call) => call[0] === "recv.event").length >= 2 ? true : undefined))

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetB })).toBe(false)
      firstReset.resolve()
      await Promise.race([
        statusStarted.promise,
        Bun.sleep(1_000).then(() => {
          throw new Error("timed out waiting for buffered status drain")
        }),
      ])

      expect(await transport.replayOnResize({ localRows: () => [], reset: resetC })).toBe(false)
      expect(resetC).not.toHaveBeenCalled()
      blockStatus = false
      statusGate.resolve()

      expect(
        await Promise.race([
          resize,
          Bun.sleep(1_000).then(() => {
            throw new Error("timed out waiting for trailing resize replay")
          }),
        ]),
      ).toBe(true)
      expect(resetB).not.toHaveBeenCalled()
      expect(resetC).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
      await active
    }
  })

  test("preserves assistant deltas not yet persisted when replaying during a live stream", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => {
          calls += 1
          return calls === 1 ? [] : [assistantMessage({ id: "msg-live", content: [text("text-live", "")] })]
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(step("msg-live"))
      src.push(textStarted("msg-live", "text-live"))
      src.push(textDelta("msg-live", "text-live", "Hello"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === "Hello"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      src.push(textDelta("msg-live", "text-live", "Hello"))
      src.push(textEnded("msg-live", "text-live", "HelloHello"))

      await waitFor(() =>
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text === "Hello").length === 2
          ? true
          : undefined,
      )
      expect(
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text).map((commit) => commit.text),
      ).toEqual(["Hello", "Hello"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("preserves the display prefix for active reasoning restored during replay", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => {
          calls += 1
          return calls === 1 ? [] : [assistantMessage({ id: "msg-thinking", content: [reasoning("thinking-1", "")] })]
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(step("msg-thinking"))
      src.push(next("reasoning.started", { assistantMessageID: "msg-thinking", reasoningID: "thinking-1" }))
      src.push(
        next("reasoning.delta", { assistantMessageID: "msg-thinking", reasoningID: "thinking-1", delta: "plan" }),
      )
      await waitFor(() => ui.commits.find((commit) => commit.kind === "reasoning" && commit.text === "Thinking: plan"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      expect(ui.commits.filter((commit) => commit.kind === "reasoning").map((commit) => commit.text)).toEqual([
        "Thinking: plan",
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not overlay stale active text when persistence completes during replay", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => {
          calls += 1
          return calls === 1
            ? []
            : [assistantMessage({ id: "msg-finished", content: [text("text-finished", "Hello")], completed: 2 })]
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(step("msg-finished"))
      src.push(textStarted("msg-finished", "text-finished"))
      src.push(textDelta("msg-finished", "text-finished", "Hello"))
      await waitFor(() => ui.commits.find((commit) => commit.kind === "assistant" && commit.text === "Hello"))
      ui.commits.length = 0

      expect(await transport.replayOnResize({ localRows: () => [], reset: () => Promise.resolve() })).toBe(true)
      expect(
        ui.commits.filter((commit) => commit.kind === "assistant" && commit.text).map((commit) => commit.text),
      ).toEqual(["Hello"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not clear the terminal when resize replay snapshot fetch fails", async () => {
    const src = eventFeed()
    const ui = footer()
    let calls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: () => {
          calls += 1
          if (calls === 1) {
            return []
          }

          throw new Error("snapshot failed")
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const reset = mock(() => Promise.resolve())

    try {
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(reset).not.toHaveBeenCalled()
      expect(ui.commits).toEqual([])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("disables resize replay for the session after terminal reset fails", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }).client,
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const reset = mock(() => Promise.reject(new Error("clear failed")))

    try {
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(await transport.replayOnResize({ localRows: () => [], reset })).toBe(false)
      expect(reset).toHaveBeenCalledTimes(1)
      expect(ui.commits).toContainEqual({
        kind: "error",
        text: "resize replay failed; disabled for this session",
        phase: "start",
        source: "system",
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("keeps completed historical subagent tabs during bootstrap", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [
                assistantMessage({
                  id: "msg-1",
                  completed: 2,
                  content: [
                    completedTool(
                      "call-1",
                      "task",
                      { description: "Explore run folder", subagent_type: "explore", prompt: "x" },
                      { sessionID: "child-1", text: "done" },
                    ),
                  ],
                }),
              ]
            : [],
        children: () => [{ id: "child-1" }],
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const state = await waitFor(() => lastSubagent(ui))
      expect(state.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "completed" })])
      expect(state.details).toEqual({})
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps a running task's child tab and its resumed blocker input", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: (sessionID) =>
          sessionID === "session-1"
            ? [
                assistantMessage({
                  id: "msg-1",
                  content: [
                    runningTool("call-1", "task", { description: "Explore run folder", subagent_type: "explore" }),
                  ],
                }),
              ]
            : [
                assistantMessage({
                  id: "msg-child-1",
                  content: [
                    runningTool("call-edit-1", "edit", {
                      path: "src/run/subagent-data.ts",
                      oldString: "a",
                      newString: "b",
                    }),
                  ],
                }),
              ],
        children: () => [{ id: "child-1" }],
        permissions: (sessionID) =>
          sessionID === "child-1"
            ? [
                {
                  id: "perm-1",
                  sessionID: "child-1",
                  action: "edit",
                  resources: ["src/run/subagent-data.ts"],
                  metadata: { filepath: "src/run/subagent-data.ts", diff: "@@ -1 +1 @@" },
                  source: { type: "tool", messageID: "msg-child-1", callID: "call-edit-1" },
                },
              ]
            : [],
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const boot = await waitFor(() => {
        const state = lastSubagent(ui)
        return state?.tabs.some((tab) => tab.sessionID === "child-1") &&
          state.permissions.some((req) => req.id === "perm-1")
          ? state
          : undefined
      })

      expect(boot.tabs).toEqual([
        expect.objectContaining({
          sessionID: "child-1",
          label: "Explore",
          description: "Pending permission",
          status: "running",
        }),
      ])
      expect(boot.permissions).toEqual([
        expect.objectContaining({ id: "perm-1", sessionID: "child-1", permission: "edit" }),
      ])

      transport.selectSubagent("child-1")

      const selected = await waitFor(() => {
        const state = lastSubagent(ui)
        return state?.details["child-1"]?.commits.some(
          (commit) => commit.kind === "tool" && commit.tool === "edit" && commit.phase === "start",
        )
          ? state
          : undefined
      })
      expect(selected.details["child-1"]?.commits).toEqual([
        expect.objectContaining({ kind: "tool", tool: "edit", phase: "start" }),
      ])

      const view = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.view")
        return item?.type === "stream.view" && item.view.type === "permission" && item.view.request.id === "perm-1"
          ? item.view
          : undefined
      })
      expect(view.request.metadata).toEqual(
        expect.objectContaining({
          diff: "@@ -1 +1 @@",
          input: expect.objectContaining({ filePath: "src/run/subagent-data.ts" }),
        }),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not block startup on child history bootstrap", async () => {
    const pending = defer<SessionMessage[]>()
    const ui = footer()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined

    const task = createSessionTransport({
      sdk: sdk({
        transcript: (sessionID) => {
          if (sessionID === "session-1") {
            return [
              assistantMessage({
                id: "msg-1",
                content: [
                  completedTool(
                    "call-1",
                    "task",
                    { description: "Explore run.ts", subagent_type: "explore" },
                    { sessionID: "child-1", text: "" },
                  ),
                ],
              }),
            ]
          }

          return sessionID === "child-1" ? pending.promise : []
        },
        children: () => [{ id: "child-1" }],
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    }).then((item) => {
      transport = item
      return item
    })

    try {
      const state = await waitFor(() => {
        const value = lastSubagent(ui)
        return value?.tabs.some((tab) => tab.sessionID === "child-1") ? value : undefined
      })
      await waitFor(() => transport)
      expect(state.tabs).toEqual([expect.objectContaining({ sessionID: "child-1" })])
      expect(state.details).toEqual({})
    } finally {
      pending.resolve([])
      await task
      await transport?.close()
    }
  })

  test("replays child events buffered during bootstrap once the spawning task links the child", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        transcript: async (sessionID) => {
          if (sessionID === "session-1") {
            await gate.promise
          }
          return []
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(next("retried", { attempt: 1, error: { message: "retry child", isRetryable: true } }, "child-1"))
      src.push(step("msg-child-1", "child-1"))
      src.push(textStarted("msg-child-1", "txt-child-1", "child-1"))
      src.push(textDelta("msg-child-1", "txt-child-1", "Hello", "child-1"))
      src.push(
        toolCalled({
          messageID: "msg-1",
          callID: "call-1",
          tool: "task",
          body: { description: "Explore run.ts", subagent_type: "explore" },
        }),
      )
      src.push(created("child-1", "session-1"))
      gate.resolve()
      transport = await task

      await waitFor(() => lastSubagent(ui)?.tabs.find((tab) => tab.sessionID === "child-1"))
      transport.selectSubagent("child-1")

      const detail = await waitFor(() => {
        const value = lastSubagent(ui)?.details["child-1"]
        return value?.commits.some((commit) => commit.kind === "error" && commit.text === "retry child") &&
          value.commits.some((commit) => commit.kind === "assistant" && commit.text === "Hello")
          ? value
          : undefined
      })
      expect(detail.sessionID).toBe("child-1")
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("streams selected subagent output from global events while it is running", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      src.push(step("msg-1"))
      src.push(
        toolCalled({
          messageID: "msg-1",
          callID: "call-1",
          tool: "task",
          body: { description: "Explore run.ts", subagent_type: "explore" },
        }),
      )
      src.push(created("child-1", "session-1"))
      await waitFor(() => lastSubagent(ui)?.tabs.find((tab) => tab.sessionID === "child-1" && tab.status === "running"))

      transport.selectSubagent("child-1")
      src.push(step("msg-child-1", "child-1"))
      src.push(textStarted("msg-child-1", "txt-child-1", "child-1"))
      src.push(textDelta("msg-child-1", "txt-child-1", "hello", "child-1"))

      expect(
        await waitFor(() => {
          const detail = lastSubagent(ui)?.details["child-1"]
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello")
            ? detail
            : undefined
        }),
      ).toEqual({ sessionID: "child-1", commits: [expect.objectContaining({ kind: "assistant", text: "hello" })] })

      src.push(textDelta("msg-child-1", "txt-child-1", " world", "child-1"))
      expect(
        await waitFor(() => {
          const detail = lastSubagent(ui)?.details["child-1"]
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello world")
            ? detail
            : undefined
        }, 2_000),
      ).toEqual({
        sessionID: "child-1",
        commits: [expect.objectContaining({ kind: "assistant", text: "hello world" })],
      })

      src.push(toolSuccess({ messageID: "msg-1", callID: "call-1", structured: { sessionID: "child-1", text: "ok" } }))
      await waitFor(() =>
        lastSubagent(ui)?.tabs.find((tab) => tab.sessionID === "child-1" && tab.status === "completed"),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("recovers pending questions from the question list when the ask is missed", async () => {
    const src = eventFeed()
    const ui = footer()
    let questionCalls = 0
    const request: QuestionV2Request = {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which area should I inspect first?",
          header: "Area",
          options: [{ label: "CLI", description: "Look at the direct run flow." }],
          multiSelect: false,
        },
      ],
      tool: { messageID: "msg-1", callID: "call-question-1" },
    }
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: () => {
          questionCalls += 1
          return questionCalls > 1 ? [request] : []
        },
        prompt: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(step("msg-1"))
            src.push(
              toolCalled({
                messageID: "msg-1",
                callID: "call-question-1",
                tool: "question",
                body: { questions: request.questions },
              }),
            )
          })
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn(turn("hello", { signal: ctrl.signal }))

      const view = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.view")
        return item?.type === "stream.view" && item.view.type === "question" ? item.view : undefined
      })
      expect(view).toEqual({ type: "question", request })
      expect(ui.events).toContainEqual({ type: "stream.patch", patch: { phase: "running", status: "awaiting answer" } })

      src.push(
        toolSuccess({
          messageID: "msg-1",
          callID: "call-question-1",
          structured: { answers: [["CLI"]] },
          output: "User has answered your questions.",
        }),
      )

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.view")
          return item?.type === "stream.view" && item.view.type === "prompt" ? item : undefined
        }),
      ).toEqual({ type: "stream.view", view: { type: "prompt" } })

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not resurrect questions if the question list resolves after tool completion", async () => {
    const src = eventFeed()
    const ui = footer()
    const started = defer()
    const request: QuestionV2Request = {
      id: "question-race-1",
      sessionID: "session-1",
      questions: [{ question: "Which area?", header: "Area", options: [], multiSelect: false }],
      tool: { messageID: "msg-1", callID: "call-question-race-1" },
    }
    const pending = defer<QuestionV2Request[]>()
    let questionCalls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: () => {
          questionCalls += 1
          if (questionCalls === 1) {
            return []
          }

          if (questionCalls === 2) {
            started.resolve()
            return pending.promise
          }

          return []
        },
        prompt: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(step("msg-1"))
            src.push(
              toolCalled({
                messageID: "msg-1",
                callID: "call-question-race-1",
                tool: "question",
                body: { questions: request.questions },
              }),
            )
          })
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn(turn("hello", { signal: ctrl.signal }))

      await started.promise
      src.push(
        toolSuccess({
          messageID: "msg-1",
          callID: "call-question-race-1",
          structured: { answers: [["CLI"]] },
          output: "ok",
        }),
      )
      await waitFor(() =>
        ui.commits.findLast(
          (item) =>
            item.kind === "tool" && item.partID === "msg-1:call-question-race-1" && item.toolState === "completed",
        ),
      )
      pending.resolve([request])

      await Bun.sleep(50)

      expect(
        ui.events.some(
          (event) =>
            event.type === "stream.view" && event.view.type === "question" && event.view.request.id === request.id,
        ),
      ).toBe(false)

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("admits V2 prompts and respects the includeFiles flag", async () => {
    const src = eventFeed()
    const ui = footer()
    const file: RunFilePart = { type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/plain" }
    const mocked = sdk({
      stream: src.stream,
      prompt: async () => {
        queueMicrotask(() => {
          src.push(busy())
          src.push(idle())
        })
      },
    })

    const transport = await createSessionTransport({
      sdk: mocked.client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn(
        turn("hello", {
          files: [file],
          includeFiles: true,
          prompt: { text: "hello", parts: [], messageID: "msg_local_1" },
        }),
      )
      await transport.runPromptTurn(turn("again", { files: [file], includeFiles: false }))

      expect(mocked.calls.prompt).toEqual([
        {
          sessionID: "session-1",
          id: "msg_local_1",
          prompt: { text: "hello", files: [{ uri: "file:///tmp/a.ts", name: "a.ts" }] },
        },
        { sessionID: "session-1", prompt: { text: "again" } },
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("switches agent and model before a prompt only when the selection changed", async () => {
    const src = eventFeed()
    const ui = footer()
    const mocked = sdk({
      stream: src.stream,
      session: { agent: "build", model: { providerID: "openai", id: "gpt-5" } },
      prompt: async () => {
        queueMicrotask(() => {
          src.push(busy())
          src.push(idle())
        })
      },
    })
    const transport = await createSessionTransport({
      sdk: mocked.client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const model = { providerID: "openai", modelID: "gpt-5" }
      await transport.runPromptTurn(turn("same", { agent: "build", model }))
      expect(mocked.calls.agent).toEqual([])
      expect(mocked.calls.model).toEqual([])

      await transport.runPromptTurn(turn("switch", { agent: "plan", model, variant: "high" }))
      expect(mocked.calls.agent).toEqual([{ sessionID: "session-1", agent: "plan" }])
      expect(mocked.calls.model).toEqual([
        { sessionID: "session-1", model: { providerID: "openai", id: "gpt-5", variant: "high" } },
      ])

      await transport.runPromptTurn(turn("again", { agent: "plan", model, variant: "high" }))
      expect(mocked.calls.agent).toHaveLength(1)
      expect(mocked.calls.model).toHaveLength(1)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("runs slash commands through the V2 command route and waits for idle", async () => {
    const src = eventFeed()
    const ui = footer()
    const mocked = sdk({
      stream: src.stream,
      command: async () => {
        queueMicrotask(() => {
          src.push(busy())
          src.push(idle())
        })
      },
    })
    const transport = await createSessionTransport({
      sdk: mocked.client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn(
        turn("/review main", {
          prompt: { text: "/review main", parts: [], command: { name: "review", arguments: "main" } },
        }),
      )
      expect(mocked.calls.command).toEqual([{ sessionID: "session-1", command: "review", arguments: "main" }])
      expect(mocked.calls.prompt).toEqual([])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("runs shell mode through the V2 shell route without starting a turn", async () => {
    const src = eventFeed()
    const ui = footer()
    const mocked = sdk({
      stream: src.stream,
      shell: async () => {
        src.push(next("shell.started", { messageID: "msg_shell", callID: "call_shell", command: "ls" }))
        src.push(next("shell.ended", { callID: "call_shell", output: "a.ts\n" }))
      },
    })
    const transport = await createSessionTransport({
      sdk: mocked.client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn(turn("ls", { prompt: { text: "ls", parts: [], mode: "shell" } }))
      expect(mocked.calls.shell).toEqual([{ sessionID: "session-1", command: "ls", resume: false }])
      await waitFor(() =>
        ui.commits.find((commit) => commit.shell?.command === "ls" && commit.toolState === "completed"),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("reports a drain failure and completes the turn on idle", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        prompt: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(
              next("failed", {
                error: { type: "unknown", message: "Session history is not migrated" },
                name: "Session.LegacyNotMigratedError",
              }),
            )
            src.push(idle())
          })
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn(turn("hello"))
      expect(ui.commits).toContainEqual(
        expect.objectContaining({ kind: "error", text: expect.stringContaining("miao db backfill") }),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("falls back to session status polling when idle events are missing", async () => {
    const src = eventFeed()
    const ui = footer()
    let running = true
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        prompt: async () => {
          queueMicrotask(() => {
            src.push(step("msg-1"))
            running = false
          })
        },
        status: () => (running ? "busy" : "idle"),
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.race([
        transport.runPromptTurn(turn("hello")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 1_000)),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("flushes interrupted output when the active turn aborts", async () => {
    const src = eventFeed()
    const seen = defer()
    const ui = footer((commit) => {
      if (commit.kind === "assistant" && commit.phase === "progress") {
        seen.resolve()
      }
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        prompt: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(step("msg-1"))
            src.push(textStarted("msg-1", "txt-1"))
            src.push(textDelta("msg-1", "txt-1", "unfinished"))
          })
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn(turn("hello", { signal: ctrl.signal }))

      await seen.promise
      ctrl.abort()
      await task

      expect(ui.commits).toEqual([
        {
          kind: "assistant",
          text: "unfinished",
          phase: "progress",
          source: "assistant",
          messageID: "msg-1",
          partID: "msg-1:txt-1",
        },
        {
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          messageID: "msg-1",
          partID: "msg-1:txt-1",
          interrupted: true,
        },
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("closes an active turn without rejecting it", async () => {
    const src = eventFeed()
    const ui = footer()
    const ready = defer()
    let aborted = false

    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        prompt: async (_params, options) => {
          ready.resolve()
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            )
          })
        },
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const task = transport.runPromptTurn(turn("hello"))

      await ready.promise
      await transport.close()
      await task

      expect(aborted).toBe(true)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rejects the active turn when the event stream faults", async () => {
    const ui = footer()
    const ready = defer()

    const transport = await createSessionTransport({
      sdk: sdk({
        subscribe: () =>
          Promise.resolve({
            stream: (async function* (): AsyncGenerator<StreamEvent> {
              await ready.promise
              yield streamEvent(busy())
              throw new Error("boom")
            })(),
          }),
        prompt: async () => {
          ready.resolve()
        },
        status: () => "busy",
      }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await expect(transport.runPromptTurn(turn("hello"))).rejects.toThrow("boom")
    } finally {
      await transport.close()
    }
  })

  test("rejects concurrent turns", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream }).client,
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn(turn("one", { signal: ctrl.signal }))
      await expect(transport.runPromptTurn(turn("two"))).rejects.toThrow("prompt already running")

      ctrl.abort()
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })
})
