/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionsInputsOutput } from "@miao/client"
import type { SessionMessage } from "@miao/schema/view-models"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_inbox_recovery"
const input = {
  id: "msg_peer_pending",
  sessionID,
  admittedSeq: 2,
  timeCreated: 3,
  prompt: { text: "Message from another process" },
  delivery: "queue" as const,
}

test("status polling recovers durable inbox inputs without live events and reconciles their promotion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const pending: SessionsInputsOutput["data"][number][] = []
  const history: SessionMessage[] = []
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}/inputs`) return json({ data: pending, hasMore: false })
    if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: history })
    return undefined
  }, tmp.path)
  try {
    await mounted.sync.session.sync(sessionID)
    pending.push(input)
    await mounted.sync.session.syncStatus(sessionID)
    expect(mounted.sync.prompt.data[input.id]).toMatchObject({ state: "admitted", delivery: "queue" })
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID])).toHaveLength(1)
    expect(mounted.sync.data.message[sessionID]).toHaveLength(0)
    history.push({ id: input.id, type: "user", text: input.prompt.text, time: { created: input.timeCreated } })
    pending.length = 0
    await mounted.sync.session.syncStatus(sessionID)
    await wait(() => mounted.sync.data.message[sessionID]?.some((entry) => entry.id === input.id) === true)
    expect(mounted.sync.prompt.data[input.id]).toBeUndefined()
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID])).toHaveLength(1)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("a live admission racing an older empty inbox snapshot survives reconciliation", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<Response>()
  const mounted = await mount(
    (url) => (url.pathname === `/api/session/${sessionID}/inputs` ? response.promise : undefined),
    tmp.path,
  )
  try {
    await mounted.sync.session.sync(sessionID)
    const read = mounted.sync.session.syncInputs(sessionID)
    mounted.emit({
      directory,
      project: "proj_test",
      payload: {
        id: "evt_racing_admission",
        type: "session.next.prompt.admitted",
        properties: {
          sessionID,
          messageID: input.id,
          timestamp: input.timeCreated,
          delivery: input.delivery,
          prompt: input.prompt,
        },
      },
    })
    await wait(() => mounted.sync.prompt.data[input.id]?.state === "admitted")
    response.resolve(json({ data: [], hasMore: false }))
    await read
    expect(mounted.sync.prompt.data[input.id]?.state).toBe("admitted")
  } finally {
    response.resolve(json({ data: [], hasMore: false }))
    mounted.app.renderer.destroy()
  }
})

test("inbox recovery pages by admission sequence", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const after: (string | null)[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/inputs`) return undefined
    after.push(url.searchParams.get("after"))
    return url.searchParams.has("after")
      ? json({ data: [{ ...input, id: "msg_peer_second", admittedSeq: 5 }], hasMore: false })
      : json({ data: [input], hasMore: true })
  }, tmp.path)
  try {
    await mounted.sync.session.syncInputs(sessionID)
    expect(after).toEqual([null, "2"])
    expect(mounted.sync.prompt.messages(sessionID, [])).toHaveLength(2)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("older attached servers without the inbox capability retain status polling without inbox requests", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const reads = { inputs: 0 }
  const mounted = await mount((url) => {
    if (url.pathname === "/api/capabilities")
      return json({ location: { directory }, data: { backgroundSubagents: false } })
    if (url.pathname !== `/api/session/${sessionID}/inputs`) return undefined
    reads.inputs += 1
    return new Response(null, { status: 404 })
  }, tmp.path)
  try {
    expect(await mounted.sync.session.syncStatus(sessionID)).toBe("idle")
    expect(await mounted.sync.session.syncStatus(sessionID)).toBe("idle")
    expect(reads.inputs).toBe(0)
  } finally {
    mounted.app.renderer.destroy()
  }
})
