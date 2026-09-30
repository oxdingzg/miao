/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_v2_delta"
const messageID = "msg_v2_delta"
const textID = "prt_v2_text"
const reasoningID = "prt_v2_reasoning"

const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "v2 delta",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory, workspaceID: undefined },
  subpath: "",
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("V2 stream deltas append in place instead of re-hydrating", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const previous = process.env["MIAO_TUI_V2"]
  process.env["MIAO_TUI_V2"] = "1"
  let contextRequests = 0
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      if (url.pathname === "/api/session") return json({ data: [session] })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/context`) {
        contextRequests += 1
        return json({
          data: [
            {
              id: messageID,
              type: "assistant",
              time: { created: 1 },
              agent: "build",
              model: { id: "model", providerID: "test" },
              content: [
                { type: "text", id: textID, text: "hello" },
                { type: "reasoning", id: reasoningID, text: "think" },
              ],
            },
          ],
        })
      }
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "busy" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    await mounted.sync.session.sync(sessionID)
    await wait(() => mounted.sync.data.part[messageID]?.[0]?.type === "text")
    const hydrated = contextRequests
    expect(mounted.sync.data.part[messageID][0]).toMatchObject({ type: "text", text: "hello" })

    mounted.emit(
      global({
        id: "evt_text_delta",
        type: "session.next.text.delta",
        properties: { timestamp: 2, sessionID, assistantMessageID: messageID, textID, delta: " world" },
      }),
    )
    mounted.emit(
      global({
        id: "evt_reasoning_delta",
        type: "session.next.reasoning.delta",
        properties: { timestamp: 2, sessionID, assistantMessageID: messageID, reasoningID, delta: " more" },
      }),
    )
    await wait(
      () =>
        mounted.sync.data.part[messageID][0].type === "text" &&
        mounted.sync.data.part[messageID][0].text === "hello world" &&
        mounted.sync.data.part[messageID][1].type === "reasoning" &&
        mounted.sync.data.part[messageID][1].text === "think more",
    )

    expect(mounted.sync.data.part[messageID][0]).toMatchObject({ type: "text", text: "hello world" })
    expect(mounted.sync.data.part[messageID][1]).toMatchObject({ type: "reasoning", text: "think more" })
    expect(contextRequests).toBe(hydrated)
  } finally {
    app?.renderer.destroy()
    if (previous === undefined) delete process.env["MIAO_TUI_V2"]
    else process.env["MIAO_TUI_V2"] = previous
  }
})

test("V2 stream deltas request a refresh when the part is not projected yet", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const previous = process.env["MIAO_TUI_V2"]
  process.env["MIAO_TUI_V2"] = "1"
  let contextRequests = 0
  let contextData: unknown[] = []
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      if (url.pathname === "/api/session") return json({ data: [session] })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/context`) {
        contextRequests += 1
        return json({ data: contextData })
      }
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "busy" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    await mounted.sync.session.sync(sessionID)
    expect(mounted.sync.data.part[messageID]).toBeUndefined()

    // A fragment lands before `session.next.text.started` has hydrated the part.
    mounted.emit(
      global({
        id: "evt_early_delta",
        type: "session.next.text.delta",
        properties: { timestamp: 2, sessionID, assistantMessageID: messageID, textID, delta: " world" },
      }),
    )

    // The server accumulated the same fragment once it projected the turn.
    contextData = [
      {
        id: messageID,
        type: "assistant",
        time: { created: 1 },
        agent: "build",
        model: { id: "model", providerID: "test" },
        content: [{ type: "text", id: textID, text: "hello world" }],
      },
    ]
    await wait(() => mounted.sync.data.part[messageID]?.[0]?.type === "text")
    expect(contextRequests).toBeGreaterThan(1)
    expect(mounted.sync.data.part[messageID][0]).toMatchObject({ type: "text", text: "hello world" })
  } finally {
    app?.renderer.destroy()
    if (previous === undefined) delete process.env["MIAO_TUI_V2"]
    else process.env["MIAO_TUI_V2"] = previous
  }
})
