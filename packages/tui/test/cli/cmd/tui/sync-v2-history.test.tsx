/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_v2_history"

const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "v2 history",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/tmp/opencode/packages/tui", workspaceID: undefined },
  subpath: "",
}

const message = (id: string, created: number, text: string) => ({
  id,
  type: "assistant" as const,
  time: { created },
  agent: "build",
  model: { id: "model", providerID: "test" },
  content: [{ type: "text" as const, id: `${id}_text`, text }],
})

// `context` only returns the window after the last compaction, so the transcript
// also pages the projected timeline to keep older messages scrollable.
test("V2 hydration keeps compacted history reachable", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const previous = process.env["MIAO_TUI_V2"]
  process.env["MIAO_TUI_V2"] = "1"
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      if (url.pathname === "/api/session") return json({ data: [session] })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/context`)
        return json({ data: [message("msg_active", 30, "after compaction")] })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        expect(url.searchParams.get("limit")).toBe("200")
        expect(url.searchParams.get("order")).toBe("desc")
        return json({
          data: [message("msg_active", 30, "stale copy"), message("msg_older", 10, "before compaction")],
          cursor: {},
        })
      }
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    await mounted.sync.session.sync(sessionID)
    await wait(() => mounted.sync.data.part["msg_older"]?.[0]?.type === "text")

    expect(mounted.sync.data.message[sessionID].map((info) => info.id)).toEqual(["msg_older", "msg_active"])
    expect(mounted.sync.data.part["msg_older"][0]).toMatchObject({ type: "text", text: "before compaction" })
    expect(mounted.sync.data.part["msg_active"][0]).toMatchObject({ type: "text", text: "after compaction" })
  } finally {
    app?.renderer.destroy()
    if (previous === undefined) delete process.env["MIAO_TUI_V2"]
    else process.env["MIAO_TUI_V2"] = previous
  }
})

test("V2 loadOlder walks the timeline behind the transcript and stops at the oldest page", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const previous = process.env["MIAO_TUI_V2"]
  process.env["MIAO_TUI_V2"] = "1"
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      if (url.pathname === "/api/session") return json({ data: [session] })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/context`)
        return json({ data: [message("msg_active", 30, "after compaction")] })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        if (url.searchParams.get("cursor") === "older")
          return json({ data: [message("msg_oldest", 1, "oldest")], cursor: {} })
        return json({ data: [message("msg_older", 10, "before compaction")], cursor: { next: "older" } })
      }
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    await mounted.sync.session.sync(sessionID)
    await wait(() => mounted.sync.data.part["msg_older"]?.[0]?.type === "text")

    expect(await mounted.sync.session.loadOlder(sessionID)).toBe(true)
    await wait(() => mounted.sync.data.part["msg_oldest"]?.[0]?.type === "text")

    expect(mounted.sync.data.message[sessionID].map((info) => info.id)).toEqual([
      "msg_oldest",
      "msg_older",
      "msg_active",
    ])
    expect(await mounted.sync.session.loadOlder(sessionID)).toBe(false)
  } finally {
    app?.renderer.destroy()
    if (previous === undefined) delete process.env["MIAO_TUI_V2"]
    else process.env["MIAO_TUI_V2"] = previous
  }
})
