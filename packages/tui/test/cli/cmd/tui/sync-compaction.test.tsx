/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "../../../../src/context/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_compaction_visibility"
function started(id: string, timestamp: number): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    payload: {
      id: `evt_${id}_${timestamp}`,
      type: "session.next.compaction.started",
      properties: { sessionID, timestamp, messageID: id, reason: "auto" },
    },
  }
}
function ended(id: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    payload: {
      id: `evt_end_${id}`,
      type: "session.next.compaction.ended",
      properties: { sessionID, timestamp: 300, messageID: id, reason: "auto", text: "summary", recent: "" },
    },
  }
}

test("live compaction is reactive, duplicate starts keep the timer, and only its matching end clears it", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  try {
    emit(started("msg_first", 100))
    await wait(() => sync.data.session_compaction[sessionID]?.since === 100)
    expect(sync.session.status(sessionID)).toBe("compacting")
    emit(started("msg_first", 150))
    emit(started("msg_second", 200))
    await wait(() => sync.data.session_compaction[sessionID]?.messageID === "msg_second")
    emit(ended("msg_first"))
    // A following ordered event is a barrier for the preceding stale end.
    emit(started("msg_second", 250))
    await Bun.sleep(50)
    expect(sync.data.session_compaction[sessionID]).toEqual({ messageID: "msg_second", since: 200 })
    emit(ended("msg_second"))
    await wait(() => sync.data.session_compaction[sessionID] === undefined)
    expect(sync.session.status(sessionID)).not.toBe("compacting")
  } finally {
    app.renderer.destroy()
  }
})

test("idle event and idle status poll recover missing compaction ends", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(
    (url) => (url.pathname === `/api/session/${sessionID}/status` ? json({ data: { type: "idle" } }) : undefined),
    tmp.path,
  )
  try {
    emit(started("msg_cancelled", 100))
    await wait(() => !!sync.data.session_compaction[sessionID])
    emit({
      directory: "/tmp/other",
      project: "proj_test",
      payload: {
        id: "evt_idle",
        type: "session.next.status",
        properties: { sessionID, timestamp: 200, status: { type: "idle" } },
      },
    })
    await wait(() => sync.data.session_compaction[sessionID] === undefined)
    emit(started("msg_lost_end", 300))
    await wait(() => !!sync.data.session_compaction[sessionID])
    expect(await sync.session.syncStatus(sessionID)).toBe("idle")
    expect(sync.data.session_compaction[sessionID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("an idle poll started before compaction cannot erase the new live indicator", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let finish!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const { app, emit, sync } = await mount(
    (url) => (url.pathname === `/api/session/${sessionID}/status` ? response : undefined),
    tmp.path,
  )
  try {
    const read = sync.session.syncStatus(sessionID)
    emit(started("msg_new", 400))
    await wait(() => sync.data.session_compaction[sessionID]?.messageID === "msg_new")
    finish(json({ data: { type: "idle" } }))
    await read
    expect(sync.data.session_compaction[sessionID]?.messageID).toBe("msg_new")
  } finally {
    app.renderer.destroy()
  }
})
