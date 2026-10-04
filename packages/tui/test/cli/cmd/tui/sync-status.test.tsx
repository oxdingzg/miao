/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

test("busy status heartbeats update status without rehydrating history; idle settles once", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_status_heartbeat"
  const reads = { context: 0 }
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "status",
          agent: "build",
          model: { id: "model", providerID: "test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          location: { directory },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/context`) {
      reads.context += 1
      return json({ data: [] })
    }
    if (url.pathname === `/api/session/${sessionID}/todo` || url.pathname === `/api/session/${sessionID}/diff`)
      return json({ data: [] })
    return undefined
  }, tmp.path)
  const emit = (id: string, type: "busy" | "idle") =>
    mounted.emit({
      directory,
      project: "proj_test",
      payload: {
        id,
        type: "session.next.status",
        properties: { sessionID, timestamp: 3, status: { type } },
      },
    })
  try {
    await mounted.sync.session.sync(sessionID)
    expect(reads.context).toBe(1)
    emit("evt_busy", "busy")
    await wait(() => mounted.sync.data.session_status[sessionID]?.type === "busy")
    Array.from({ length: 10 }, (_, i) => emit(`evt_heartbeat_${i}`, "busy"))
    // Observe beyond the scheduler's 200ms debounce to catch accidental fetches.
    await Bun.sleep(250)
    expect(reads.context).toBe(1)
    emit("evt_idle", "idle")
    await wait(() => reads.context === 2)
    emit("evt_idle_repeat", "idle")
    await Bun.sleep(250)
    expect(mounted.sync.data.session_status[sessionID]?.type).toBe("idle")
    expect(reads.context).toBe(2)
  } finally {
    mounted.app.renderer.destroy()
  }
})
