/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const assistant = (id: string, text: string) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "fixture", providerID: "fixture" },
  time: { created: 1, completed: 2 },
  content: [{ id: `${id}_text`, type: "text", text }],
})
const permission = (sessionID: string, id: string) => ({ id, sessionID, action: "write", resources: ["file.txt"] })
const question = (sessionID: string, id: string) => ({
  id,
  sessionID,
  questions: [
    {
      header: "Choice",
      question: "Continue?",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
})
const connected = (id: string) => ({
  directory: "global",
  payload: { id, type: "server.connected" as const, properties: {} },
})

test("an HTTP SSE reconnect restores visible history and pending requests without loading hidden sessions", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const active = "ses_reconnect_active"
  const hidden = "ses_reconnect_hidden"
  let offline = false
  const reads = new Map<string, number>()
  const requestReads = new Map<string, number>()
  const mounted = await mount(
    (url) => {
      const id = url.pathname.split("/")[3]
      if (url.pathname.endsWith("/context")) {
        reads.set(id, (reads.get(id) ?? 0) + 1)
        return json({ data: [assistant(`msg_${id}`, offline ? "committed during the gap" : "before the gap")] })
      }
      if (url.pathname.endsWith("/permission")) {
        requestReads.set(id, (requestReads.get(id) ?? 0) + 1)
        return json({ data: offline ? [permission(id, "per_missed")] : [] })
      }
      if (url.pathname.endsWith("/question")) return json({ data: offline ? [question(id, "que_missed")] : [] })
      return undefined
    },
    tmp.path,
    { http: true },
  )
  try {
    await wait(() => mounted.events.connections === 1)
    mounted.emit(connected("evt_connection_1"))
    mounted.sync.session.pin(active)
    await mounted.sync.session.sync(active)
    await mounted.sync.session.sync(hidden)
    await wait(() => requestReads.get(active) === 1 && requestReads.get(hidden) === 1)
    mounted.emit({
      directory,
      payload: {
        type: "session.next.text.started",
        properties: {
          timestamp: 3,
          sessionID: active,
          assistantMessageID: `msg_${active}`,
          textID: `msg_${active}_text`,
        },
      },
    })
    mounted.emit({
      directory,
      payload: {
        type: "session.next.text.delta",
        properties: {
          timestamp: 4,
          sessionID: active,
          assistantMessageID: `msg_${active}`,
          textID: `msg_${active}_text`,
          delta: "obsolete partial reply",
        },
      },
    })
    await wait(() => {
      const message = mounted.sync.data.message[active]?.[0]
      return (
        message?.type === "assistant" &&
        message.content[0]?.type === "text" &&
        message.content[0].text === "obsolete partial reply"
      )
    })
    const hiddenReads = reads.get(hidden)
    mounted.events.disconnect()
    offline = true
    await wait(() => mounted.events.connections === 2, 5000)
    mounted.emit(connected("evt_connection_2"))
    await wait(() => mounted.sync.data.permission[active]?.[0]?.id === "per_missed")
    await wait(() => mounted.sync.data.question[active]?.[0]?.id === "que_missed")
    await wait(() => {
      const message = mounted.sync.data.message[active]?.[0]
      return (
        message?.type === "assistant" &&
        message.content[0]?.type === "text" &&
        message.content[0].text === "committed during the gap"
      )
    })
    expect(mounted.sync.data.message[active].map((message) => message.id)).toEqual([`msg_${active}`])
    expect(reads.get(hidden)).toBe(hiddenReads)
    expect(requestReads.get(hidden)).toBe(1)
    // Hidden snapshots are invalidated without fetching them until opened.
    await mounted.sync.session.sync(hidden)
    await wait(() => mounted.sync.data.permission[hidden]?.[0]?.id === "per_missed")
    expect(reads.get(hidden)).toBe((hiddenReads ?? 0) + 1)
  } finally {
    mounted.app.renderer.destroy()
  }
}, 10_000)

test("request recovery cannot resurrect live replies or lose requests asked during the snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_reconnect_requests"
  const permissions = Promise.withResolvers<Response>()
  const questions = Promise.withResolvers<Response>()
  let reads = 0
  let recover = false
  const mounted = await mount((url) => {
    if (url.pathname.endsWith("/permission")) {
      reads += 1
      return recover ? permissions.promise : json({ data: [permission(sessionID, "per_old")] })
    }
    if (url.pathname.endsWith("/question"))
      return recover ? questions.promise : json({ data: [question(sessionID, "que_old")] })
    return undefined
  }, tmp.path)
  try {
    mounted.sync.session.pin(sessionID)
    await mounted.sync.session.sync(sessionID)
    await wait(() => mounted.sync.data.permission[sessionID]?.[0]?.id === "per_old")
    await wait(() => mounted.sync.data.question[sessionID]?.[0]?.id === "que_old")
    recover = true
    mounted.emit(connected("evt_reconnect_requests"))
    await wait(() => reads === 2)
    mounted.emit({
      directory,
      payload: { type: "permission.v2.replied", properties: { sessionID, requestID: "per_old", reply: "once" } },
    })
    mounted.emit({
      directory,
      payload: { type: "question.v2.rejected", properties: { sessionID, requestID: "que_old" } },
    })
    mounted.emit({ directory, payload: { type: "permission.v2.asked", properties: permission(sessionID, "per_new") } })
    mounted.emit({ directory, payload: { type: "question.v2.asked", properties: question(sessionID, "que_new") } })
    await wait(
      () =>
        mounted.sync.data.permission[sessionID]?.some((request) => request.id === "per_new") === true &&
        mounted.sync.data.question[sessionID]?.some((request) => request.id === "que_new") === true,
    )
    permissions.resolve(json({ data: [permission(sessionID, "per_old"), permission(sessionID, "per_snapshot")] }))
    questions.resolve(json({ data: [question(sessionID, "que_old"), question(sessionID, "que_snapshot")] }))
    // Snapshot-only IDs prove the read has applied before testing the races.
    await wait(() => mounted.sync.data.permission[sessionID]?.some((request) => request.id === "per_snapshot") === true)
    expect(mounted.sync.data.permission[sessionID].map((request) => request.id)).toEqual(["per_new", "per_snapshot"])
    expect(mounted.sync.data.question[sessionID].map((request) => request.id)).toEqual(["que_new", "que_snapshot"])
  } finally {
    permissions.resolve(json({ data: [] }))
    questions.resolve(json({ data: [] }))
    mounted.app.renderer.destroy()
  }
})

test("a history read started before reconnect cannot satisfy the recovery read", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_reconnect_inflight"
  const old = Promise.withResolvers<Response>()
  let reads = 0
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}/context`) {
      reads += 1
      return reads === 1 ? old.promise : json({ data: [assistant("msg_final", "after reconnect")] })
    }
    return undefined
  }, tmp.path)
  try {
    mounted.sync.session.pin(sessionID)
    const before = mounted.sync.session.sync(sessionID)
    await wait(() => reads === 1)
    mounted.emit(connected("evt_reconnect_inflight"))
    old.resolve(json({ data: [assistant("msg_old", "stale snapshot")] }))
    await before
    expect(mounted.sync.data.message[sessionID] ?? []).toEqual([])
    await wait(() => mounted.sync.data.message[sessionID]?.[0]?.id === "msg_final")
    expect(mounted.sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_final"])
    expect(reads).toBe(2)
  } finally {
    old.resolve(json({ data: [] }))
    mounted.app.renderer.destroy()
  }
})
