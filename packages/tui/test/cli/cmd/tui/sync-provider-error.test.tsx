/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "../../../../src/context/sdk"

const sessionID = "ses_provider_error"
const payload = (event: GlobalEvent["payload"]): GlobalEvent => ({ directory, project: "proj_test", payload: event })

test("429 retry notices are visible and survive busy polling until provider output recovers", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const reads = { context: 0 }
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}/context`) {
      reads.context += 1
      return json({ data: [] })
    }
    if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "busy" } })
    return undefined
  }, tmp.path)
  try {
    await mounted.sync.session.sync(sessionID)
    mounted.emit(
      payload({
        id: "evt_retry_429",
        type: "session.next.retried",
        properties: {
          sessionID,
          timestamp: 3,
          attempt: 1,
          error: { message: "Too many requests", statusCode: 429, isRetryable: true },
        },
      }),
    )
    await wait(() => mounted.sync.data.session_status[sessionID]?.type === "retry")
    expect(mounted.sync.data.session_status[sessionID]).toMatchObject({
      type: "retry",
      attempt: 1,
      message: "API Error: 429 · Too many requests",
    })
    await mounted.sync.session.syncStatus(sessionID)
    expect(mounted.sync.data.session_status[sessionID]?.type).toBe("retry")
    mounted.emit(
      payload({
        id: "evt_busy_while_retrying",
        type: "session.next.status",
        properties: { sessionID, timestamp: 4, status: { type: "busy" } },
      }),
    )
    await Bun.sleep(250) // Observe beyond the history refresh debounce.
    expect(reads.context).toBe(1)
    expect(mounted.sync.data.session_status[sessionID]?.type).toBe("retry")
    mounted.emit(
      payload({
        id: "evt_provider_recovered",
        type: "session.next.text.started",
        properties: {
          sessionID,
          timestamp: 5,
          assistantMessageID: "msg_recovered",
          textID: "text_recovered",
        },
      }),
    )
    await wait(() => mounted.sync.data.session_status[sessionID]?.type === "busy")
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("a failure before an assistant step remains visible after idle status polling", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mount(undefined, tmp.path)
  try {
    mounted.emit(
      payload({
        id: "evt_model_failure",
        type: "session.next.failed",
        properties: {
          sessionID,
          timestamp: 3,
          error: { type: "unknown", message: "No model is available" },
        },
      }),
    )
    await wait(() => mounted.sync.data.session_error[sessionID] === "No model is available")
    expect(await mounted.sync.session.syncStatus(sessionID)).toBe("idle")
    expect(mounted.sync.data.session_error[sessionID]).toBe("No model is available")
    mounted.emit(
      payload({
        id: "evt_new_drain",
        type: "session.next.status",
        properties: { sessionID, timestamp: 4, status: { type: "busy" } },
      }),
    )
    await wait(() => mounted.sync.data.session_error[sessionID] === undefined)
  } finally {
    mounted.app.renderer.destroy()
  }
})
